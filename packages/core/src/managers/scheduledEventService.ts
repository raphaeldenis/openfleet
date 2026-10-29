import { OpenFleetError } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { newId } from '../ids.js';
import { log } from '../logger.js';
import type { SessionService } from '../sessions/sessionService.js';
import { instantOfLocalDateTime, localDateTimeOf } from './localDateTime.js';
import { modeOf, type ManagerRepository } from './managerRepository.js';
import { ScheduledEventRepository, type ScheduledEvent, type ScheduledEventCreator } from './scheduledEventRepository.js';

export const SCHEDULED_EVENT_PREFIX = '[scheduled event';
export const MAX_PENDING_EVENTS_PER_MANAGER = 20;
export const MAX_EVENT_MESSAGE_BYTES = 8192;
export const MAX_EVENT_TITLE_CHARS = 80;
export const MAX_EVENT_DELAY_MINUTES = 60 * 24 * 366;
const LATE_AFTER_MS = 60_000;
const MINUTE_MS = 60_000;
export const DELIVERY_RETRY_DELAY_MS = 60_000;
// setTimeout clamps any longer delay to 1 ms.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface ScheduledEventServiceDeps {
  repository: ScheduledEventRepository;
  sessions: SessionService;
  managers: Pick<ManagerRepository, 'getWithinBounds'>;
  bus: EventBus;
}

export interface ScheduleEventInput {
  managerId: string;
  creator: ScheduledEventCreator;
  message: string;
  title?: string;
  /** A local wall clock without offset, e.g. 2026-10-31T09:30:00. */
  at?: string;
  inMinutes?: number;
}

const invalidBody = (message: string, hint?: string) => new OpenFleetError('invalid_body', message, { hint });

const singleLineTitleOf = (title: string): string => title.replace(/[\s\p{Cc}]+/gu, ' ').replaceAll('"', "'").trim();

/** The line the manager reads: what it is, when it was due, and whether it arrives late. */
export const scheduledEventBodyOf = ({ event, deliveredAt }: { event: ScheduledEvent; deliveredAt: Date }): string => {
  const due = new Date(event.dueAt);
  const isLate = deliveredAt.getTime() - due.getTime() > LATE_AFTER_MS;
  const titlePart = event.title ? ` "${event.title}",` : '';
  const latePart = isLate ? ', delivered late' : '';
  return `${SCHEDULED_EVENT_PREFIX}${titlePart} due ${localDateTimeOf(due)}${latePart}] ${event.message}`;
};

export class ScheduledEventService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAtOfFailedDelivery = new Map<string, number>();
  private isStopped = false;

  constructor(private readonly deps: ScheduledEventServiceDeps) {
    // A reopened manager and a resumed one are the two ways a held event becomes deliverable besides the clock.
    deps.bus.subscribe((event) => {
      if (event.type === 'session.reopened') this.deliverDueEventsOf(event.sessionId);
      if (event.type === 'manager.updated') this.deliverDueEventsOf(event.manager.sessionId);
    });
  }

  /** Delivers the events that came due while the app was closed (late), then arms the timers of the others. */
  start(): void {
    this.isStopped = false;
    for (const managerId of this.deps.repository.managerIdsWithPendingEvents()) this.deliverDueEventsOf(managerId);
  }

  stop(): void {
    this.isStopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  schedule(input: ScheduleEventInput): ScheduledEvent {
    const message = this.validMessageOf(input.message);
    const title = this.validTitleOf(input.title);
    const dueAt = this.validDueAtOf(input);
    const hasRoom = this.deps.repository.countPendingOf(input.managerId) < MAX_PENDING_EVENTS_PER_MANAGER;
    if (!hasRoom) throw new OpenFleetError('too_many_pending', `you already have ${MAX_PENDING_EVENTS_PER_MANAGER} pending scheduled events.`, { hint: 'cancel one with cancel_argus_event, or wait for one to fire.' });
    const event = { id: newId(), managerId: input.managerId, creator: input.creator, ...(title && { title }), message, dueAt, createdAt: new Date().toISOString() };
    this.deps.repository.insert(event);
    this.armTimerOf(input.managerId);
    return this.requireEvent(event.id);
  }

  pendingOf(managerId: string): ScheduledEvent[] {
    return this.deps.repository.pendingOf(managerId);
  }

  /** Only the actor that scheduled an event cancels it; another manager's event reads like one that never existed. */
  cancel({ managerId, eventId, actor }: { managerId: string; eventId: string; actor: ScheduledEventCreator }): void {
    const event = this.deps.repository.get(eventId);
    const isPendingEventOfManager = event !== undefined && event.managerId === managerId && event.status === 'pending';
    if (!isPendingEventOfManager) throw new OpenFleetError('not_found', 'no pending scheduled event has this id.', { hint: 'list your events with list_argus_events.' });
    if (event.creator !== actor) throw new OpenFleetError('outside_lineage', `this event was scheduled by the ${event.creator}: only the ${event.creator} cancels it.`);
    this.deps.repository.settle(eventId, 'cancelled');
    this.armTimerOf(managerId);
  }

  private requireEvent(id: string): ScheduledEvent {
    const event = this.deps.repository.get(id);
    if (!event) throw new Error(`scheduled event ${id} vanished after insert`);
    return event;
  }

  private validMessageOf(message: string): string {
    const trimmed = message.trim();
    if (trimmed === '') throw invalidBody('the event message is empty.');
    const byteLength = Buffer.byteLength(trimmed, 'utf8');
    if (byteLength > MAX_EVENT_MESSAGE_BYTES) throw new OpenFleetError('message_too_long', `message too long: ${byteLength} bytes, max ${MAX_EVENT_MESSAGE_BYTES}`);
    return trimmed;
  }

  private validTitleOf(title: string | undefined): string | undefined {
    const singleLine = title === undefined ? '' : singleLineTitleOf(title);
    if (singleLine.length > MAX_EVENT_TITLE_CHARS) throw invalidBody(`the event title is above ${MAX_EVENT_TITLE_CHARS} characters.`);
    return singleLine === '' ? undefined : singleLine;
  }

  private validDueAtOf({ at, inMinutes }: Pick<ScheduleEventInput, 'at' | 'inMinutes'>): string {
    const hasAt = at !== undefined;
    const hasDelay = inMinutes !== undefined;
    if (hasAt && hasDelay) throw invalidBody('give either at or in_minutes, not both.');
    if (!hasAt && !hasDelay) throw invalidBody('give either at (a local time like 2026-10-31T09:30:00) or in_minutes.');
    const now = Date.now();
    const due = hasAt ? this.dueOfLocalTime(at) : this.dueAfterMinutes(inMinutes!, now);
    if (due.getTime() <= now) throw invalidBody('the event time is in the past.', 'give a time after now.');
    return due.toISOString();
  }

  private dueOfLocalTime(at: string): Date {
    const due = instantOfLocalDateTime(at);
    if (!due) throw invalidBody('at is not a local time without offset.', 'use the form 2026-10-31T09:30:00, in your local time zone, with no Z and no +hh:mm.');
    return due;
  }

  private dueAfterMinutes(inMinutes: number, now: number): Date {
    const isInRange = Number.isFinite(inMinutes) && inMinutes > 0 && inMinutes <= MAX_EVENT_DELAY_MINUTES;
    if (!isInRange) throw invalidBody(`in_minutes is between 0 and ${MAX_EVENT_DELAY_MINUTES}.`);
    return new Date(now + Math.ceil(inMinutes * MINUTE_MS));
  }

  /** A closed or disabled manager keeps its due events pending: reopening or reactivating it delivers them. A sleeping manager receives them. */
  private canReceiveEvents(managerId: string): boolean {
    const session = this.deps.sessions.get(managerId);
    const record = this.deps.managers.getWithinBounds(managerId);
    const isOpen = session !== undefined && session.state !== 'closed';
    return isOpen && record !== undefined && modeOf(record) !== 'disabled';
  }

  private deliverDueEventsOf(managerId: string): void {
    if (this.isStopped) return;
    if (this.canReceiveEvents(managerId)) {
      const now = Date.now();
      const dueEvents = this.deps.repository.pendingOf(managerId).filter((event) => new Date(event.dueAt).getTime() <= now);
      for (const event of dueEvents) this.deliver(event);
    }
    this.armTimerOf(managerId);
  }

  // The event goes through the persisted message queue like any message to the manager: a manager in the middle of a turn reads it once that turn ends.
  private deliver(event: ScheduledEvent): void {
    try {
      const body = scheduledEventBodyOf({ event, deliveredAt: new Date() });
      this.deps.sessions.sendMessage({ sessionId: event.managerId, body });
      this.deps.repository.settle(event.id, 'delivered');
      this.retryAtOfFailedDelivery.delete(event.id);
    } catch (error) {
      this.retryAtOfFailedDelivery.set(event.id, Date.now() + DELIVERY_RETRY_DELAY_MS);
      log('error', `scheduled event ${event.id} could not be delivered to manager ${event.managerId}; it stays pending and is retried in ${DELIVERY_RETRY_DELAY_MS / 1000} s`, error);
    }
  }

  private armTimerOf(managerId: string): void {
    this.clearTimerOf(managerId);
    if (this.isStopped) return;
    const now = Date.now();
    const wakeUpTimes = this.deps.repository
      .pendingOf(managerId)
      .flatMap((event) => [new Date(event.dueAt).getTime(), this.retryAtOfFailedDelivery.get(event.id)])
      .filter((time): time is number => time !== undefined && time > now);
    if (wakeUpTimes.length === 0) return;
    const delayMs = Math.min(Math.min(...wakeUpTimes) - now, MAX_TIMER_DELAY_MS);
    this.timers.set(managerId, setTimeout(() => this.deliverDueEventsOf(managerId), delayMs));
  }

  private clearTimerOf(managerId: string): void {
    const timer = this.timers.get(managerId);
    if (timer) clearTimeout(timer);
    this.timers.delete(managerId);
  }
}
