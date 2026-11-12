import type { IntegrationIssueItem, TriggerWhen } from '@openfleet/shared';
import { pollQueryOf as pollQueryOfViewConfig, type PollQuery } from '../integrations/integrationViewConfig.js';
import type { IntegrationRepository } from '../integrations/integrationRepository.js';
import { log } from '../logger.js';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import { INTEGRATION_CURSOR_KIND, type TriggerCursors } from './triggerCursors.js';
import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

/** What one run offers before it hands the rest to the next tick. */
export const MAX_OFFERS_PER_RUN = 20;
export const NEXT_TICK_DELAY_MS = 1000;
const MAX_CURSOR_ITEMS = 1000;

type IntegrationWhen = Extract<TriggerWhen, { source: 'integration_records' }>;
type IntegrationTrigger = TriggerRecord & { when: IntegrationWhen };
const isIntegrationTrigger = (trigger: TriggerRecord): trigger is IntegrationTrigger => trigger.when.source === 'integration_records';

/** What an integration trigger remembers: the revision of each item it has dealt with, and whether the first look at the items has been made. */
interface IntegrationCursor { kind: typeof INTEGRATION_CURSOR_KIND; isBaselined: boolean; queryIdentity: string; revisions: Record<string, string> }
const isIntegrationCursor = (value: unknown): value is IntegrationCursor => {
  const candidate = value as Partial<IntegrationCursor> | null;
  const { revisions } = candidate ?? {};
  const isRevisionMap = typeof revisions === 'object' && revisions !== null && !Array.isArray(revisions)
    && Object.keys(revisions).length <= MAX_CURSOR_ITEMS && Object.values(revisions).every((revision) => typeof revision === 'string');
  return candidate?.kind === INTEGRATION_CURSOR_KIND && typeof candidate.isBaselined === 'boolean' && typeof candidate.queryIdentity === 'string' && isRevisionMap;
};

type Change = 'new' | 'changed';
interface Offer { dedupKey: string; event: Record<string, unknown>; dueAtMs: number }
type Mode = 'live' | 'backlog';

/** The state of an item: its last update, or a digest of what is kept of it when the provider gave no date. */
const revisionOf = (item: IntegrationIssueItem): string => item.updatedAt ?? `digest-${canonicalDigestOf(item.untrusted)}`;

const isWantedChange = (event: IntegrationWhen['event'], change: Change): boolean =>
  event === 'new_or_changed_record' || (event === 'new_record' && change === 'new') || (event === 'changed_record' && change === 'changed');

const matchesTheFilter = (when: IntegrationWhen, item: IntegrationIssueItem): boolean => {
  const isOfTheKeyPrefix = when.keyPrefix === undefined || item.key.startsWith(`${when.keyPrefix}-`);
  const hasAWantedStatus = when.statuses === undefined || (item.untrusted.status !== undefined && when.statuses.includes(item.untrusted.status));
  return isOfTheKeyPrefix && hasAWantedStatus;
};

export interface IntegrationRecordsSourceDeps {
  integrations: Pick<IntegrationRepository, 'findProfileInProject' | 'listItems' | 'healthOf' | 'connectionPollingOf' | 'findViewConfig' | 'onItemsReplaced'>;
  triggers: Pick<TriggerRepository, 'listArmed'>;
  cursors: Pick<TriggerCursors, 'read' | 'save'>;
  engine: Pick<TriggerEngine, 'submit' | 'submitBacklog'>;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Offers the engine the items of an integration of the project that are new or changed since the baseline of the trigger. The baseline is the revision of each item at the first look,
 * so the items present at arming never fire, and neither do the items of a query a human approved after it. Only the key, the revision and the kind of change leave this source: the text of an item is third-party text and is never read into an offer.
 * A run offers its page to the engine (the ledger keeps the fire once per dedup key), then moves the cursor past it.
 */
export class IntegrationRecordsSource {
  private unsubscribe: (() => void) | undefined;
  private readonly pendingTicks = new Map<string, () => void>();

  constructor(private readonly deps: IntegrationRecordsSourceDeps) {}

  /** Offers what changed while the daemon was stopped, then follows the polls. */
  start(): void {
    this.unsubscribe = this.deps.integrations.onItemsReplaced((integrationId) => this.pollIntegration(integrationId));
    for (const trigger of this.armedIntegrationTriggers()) this.guarded(() => this.readItemsOf(trigger, 'backlog'));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const cancel of this.pendingTicks.values()) cancel();
    this.pendingTicks.clear();
  }

  /** Takes the items as they stand as the baseline of a trigger that was just armed: what changed while it was disarmed is not offered. */
  startFromNow(trigger: TriggerRecord): void {
    if (!isIntegrationTrigger(trigger)) return;
    this.guarded(() => {
      if (!this.isInScope(trigger)) return;
      this.cancelTick(trigger.id);
      this.deps.cursors.save(trigger.id, this.baselineOf(trigger));
    });
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      log('error', 'the integration records source failed on a trigger', error);
    }
  }

  private armedIntegrationTriggers(): IntegrationTrigger[] {
    return this.deps.triggers.listArmed().filter(isIntegrationTrigger);
  }

  private pollIntegration(integrationId: string): void {
    for (const trigger of this.armedIntegrationTriggers().filter((candidate) => candidate.when.integrationId === integrationId)) this.guarded(() => this.readItemsOf(trigger, 'live'));
  }

  /** The integration must belong to the project of the trigger; one that does not, or that does not exist, is read as nothing. */
  private isInScope(trigger: IntegrationTrigger): boolean {
    return this.deps.integrations.findProfileInProject(trigger.projectId, trigger.when.integrationId) !== undefined;
  }

  /** A refused credential, or an approved view that is withheld, leaves the items as they were last seen: they are stale, so no offer is made of them. */
  private isReadable(trigger: IntegrationTrigger): boolean {
    const { integrations } = this.deps;
    const profile = integrations.findProfileInProject(trigger.projectId, trigger.when.integrationId);
    if (profile === undefined) return false;
    const isCredentialRefused = integrations.healthOf(profile.id)?.status === 'auth_failed' || integrations.connectionPollingOf(profile.connectionId).isStopped;
    const isViewWithheld = this.pollQueryOf(trigger).kind === 'withheld';
    return !isCredentialRefused && !isViewWithheld;
  }

  private pollQueryOf(trigger: IntegrationTrigger): PollQuery {
    return pollQueryOfViewConfig(this.deps.integrations.findViewConfig(trigger.when.integrationId));
  }

  /** What the poller asks the provider for: another query gives another set of items, which is no change of the items. */
  private queryIdentityOf(trigger: IntegrationTrigger): string {
    return this.pollQueryOf(trigger).identity;
  }

  private baselineOf(trigger: IntegrationTrigger): IntegrationCursor {
    const items = this.deps.integrations.listItems(trigger.when.integrationId);
    const hasBeenFetched = items.length > 0;
    return { kind: INTEGRATION_CURSOR_KIND, isBaselined: hasBeenFetched, queryIdentity: this.queryIdentityOf(trigger), revisions: Object.fromEntries(items.map((item) => [item.key, revisionOf(item)])) };
  }

  private cursorOf(trigger: TriggerRecord): IntegrationCursor | undefined {
    const stored = this.deps.cursors.read(trigger.id);
    return isIntegrationCursor(stored) ? stored : undefined;
  }

  /** One run: the first look sets the baseline and offers nothing; the next ones offer the items whose revision differs from it, within the budget. */
  private readItemsOf(trigger: IntegrationTrigger, mode: Mode): void {
    const { cursors, integrations } = this.deps;
    if (!this.isReadable(trigger)) return void this.cancelTick(trigger.id);

    const cursor = this.cursorOf(trigger);
    const isFirstLook = cursor === undefined || !cursor.isBaselined;
    const isAnotherQuery = cursor !== undefined && cursor.queryIdentity !== this.queryIdentityOf(trigger);
    if (isFirstLook || isAnotherQuery) return void cursors.save(trigger.id, this.baselineOf(trigger));

    const items = integrations.listItems(trigger.when.integrationId);
    const changedItems = items.filter((item) => cursor.revisions[item.key] !== revisionOf(item)).sort((first, second) => revisionOf(first).localeCompare(revisionOf(second)) || first.key.localeCompare(second.key));
    const dealtWith = changedItems.slice(0, MAX_OFFERS_PER_RUN);
    const deferred = new Set(changedItems.slice(MAX_OFFERS_PER_RUN).map((item) => item.key));

    const offers = dealtWith.flatMap((item) => this.offersOf(trigger, item, cursor.revisions[item.key] === undefined ? 'new' : 'changed'));
    this.offer(trigger, offers, mode);

    const revisions = Object.fromEntries(items.flatMap((item) => {
      const revision = deferred.has(item.key) ? cursor.revisions[item.key] : revisionOf(item);
      return revision === undefined ? [] : [[item.key, revision]];
    }));
    cursors.save(trigger.id, { kind: INTEGRATION_CURSOR_KIND, isBaselined: true, queryIdentity: cursor.queryIdentity, revisions } satisfies IntegrationCursor);
    if (deferred.size > 0) this.continueOnTheNextTick(trigger.id);
  }

  private offersOf(trigger: IntegrationTrigger, item: IntegrationIssueItem, change: Change): Offer[] {
    const { when } = trigger;
    if (!isWantedChange(when.event, change) || !matchesTheFilter(when, item)) return [];
    const revision = revisionOf(item);
    const event = { integration: { id: when.integrationId }, record: { key: item.key, revision, change } };
    const updatedAtMs = Date.parse(revision);
    return [{ dedupKey: `integration:${when.integrationId}:${item.key}:${revision}`, event, dueAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : this.deps.clock() }];
  }

  private offer(trigger: IntegrationTrigger, offers: Offer[], mode: Mode): void {
    const { engine } = this.deps;
    if (mode === 'backlog') {
      if (offers.length > 0) engine.submitBacklog({ triggerId: trigger.id, offers });
      return;
    }
    for (const offer of offers) engine.submit({ triggerId: trigger.id, dedupKey: offer.dedupKey, event: offer.event });
  }

  /** One tick per trigger at a time; what a run left over is read as a backlog. */
  private continueOnTheNextTick(triggerId: string): void {
    if (this.pendingTicks.has(triggerId)) return;
    const cancel = this.deps.schedule(() => {
      this.pendingTicks.delete(triggerId);
      const trigger = this.armedIntegrationTriggers().find((candidate) => candidate.id === triggerId);
      if (trigger !== undefined) this.guarded(() => this.readItemsOf(trigger, 'backlog'));
    }, NEXT_TICK_DELAY_MS);
    this.pendingTicks.set(triggerId, cancel);
  }

  private cancelTick(triggerId: string): void {
    this.pendingTicks.get(triggerId)?.();
    this.pendingTicks.delete(triggerId);
  }
}
