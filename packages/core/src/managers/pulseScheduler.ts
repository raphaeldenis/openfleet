import type { EventBus } from '../events/eventBus.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ManagerRecord, ManagerRepository } from './managerRepository.js';
import { toManagerView } from './managerView.js';
import { nextPulseAt } from './pulseTiming.js';

export const PULSE_MESSAGE = '[pulse] Re-read your mission and continue: check your children, unblock them, record what you did.';

export interface PulseSchedulerDeps {
  managers: ManagerRepository;
  sessions: SessionService;
  bus: EventBus;
}

export class PulseScheduler {
  private readonly deps: PulseSchedulerDeps;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: PulseSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    for (const record of this.deps.managers.list()) {
      if (this.isManagerAlive(record.sessionId)) this.arm(record);
    }
  }

  onManagerCreated(record: ManagerRecord): void {
    this.arm(record);
  }

  pulseNow(sessionId: string): ManagerRecord | undefined {
    const record = this.deps.managers.get(sessionId);
    if (!record) return undefined;
    if (!this.isManagerAlive(sessionId)) return undefined; // a closed manager is never pulsed
    this.clearTimer(sessionId);
    this.fire(record, new Date().toISOString());
    return this.deps.managers.get(sessionId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(record: ManagerRecord, scheduledFor?: string): void {
    this.clearTimer(record.sessionId);
    const dueAt = scheduledFor ?? nextPulseAt(record);
    const delayMs = Math.max(0, new Date(dueAt).getTime() - Date.now());
    this.timers.set(record.sessionId, setTimeout(() => this.tick(record.sessionId, dueAt), delayMs));
  }

  private tick(sessionId: string, dueAt: string): void {
    const record = this.deps.managers.get(sessionId);
    if (!record) return; // manager record removed
    if (!this.isManagerAlive(sessionId)) { this.clearTimer(sessionId); return; } // a closed manager never reschedules itself
    this.fire(record, dueAt);
  }

  private isManagerAlive(sessionId: string): boolean {
    const session = this.deps.sessions.get(sessionId);
    return session !== undefined && session.state !== 'closed';
  }

  private fire(record: ManagerRecord, scheduledFor: string): void {
    // Goes through the ordinary message queue, exactly like a message from a parent or sibling: if the
    // manager is mid-turn or waiting on a human, the pulse queues and is flushed on its next idle turn —
    // it never interrupts a running tool or answers a permission prompt.
    const pulseAlreadyQueued = this.deps.sessions.hasQueuedMessage(record.sessionId, PULSE_MESSAGE);
    let latest = record;
    if (!pulseAlreadyQueued) {
      this.deps.sessions.sendMessage({ sessionId: record.sessionId, body: PULSE_MESSAGE });
      const pulsedAt = new Date().toISOString();
      this.deps.managers.setLastPulseAt(record.sessionId, pulsedAt);
      latest = { ...record, lastPulseAt: pulsedAt };
      const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
      this.deps.bus.emit({ type: 'manager.pulsed', manager: toManagerView(latest, childrenCount) });
    }
    // The cadence keeps advancing pulseSeconds at a time from the moment this fire was due, regardless of
    // whether it actually enqueued a message — a coalesced (already-queued) pulse must not stall the timer
    // at a zero delay by rescheduling from a lastPulseAt that never moved.
    const nextDueAt = new Date(new Date(scheduledFor).getTime() + record.pulseSeconds * 1000).toISOString();
    this.arm(latest, nextDueAt);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
