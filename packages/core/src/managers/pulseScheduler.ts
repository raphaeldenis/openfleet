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
    for (const record of this.deps.managers.list()) this.arm(record);
  }

  onManagerCreated(record: ManagerRecord): void {
    this.arm(record);
  }

  pulseNow(sessionId: string): ManagerRecord | undefined {
    const record = this.deps.managers.get(sessionId);
    if (!record) return undefined;
    if (!this.isManagerAlive(sessionId)) return undefined; // a closed manager is never pulsed
    this.clearTimer(sessionId);
    this.fire(record);
    return this.deps.managers.get(sessionId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(record: ManagerRecord): void {
    this.clearTimer(record.sessionId);
    const delayMs = Math.max(0, new Date(nextPulseAt(record)).getTime() - Date.now());
    this.timers.set(record.sessionId, setTimeout(() => this.tick(record.sessionId), delayMs));
  }

  private tick(sessionId: string): void {
    const record = this.deps.managers.get(sessionId);
    if (!record) return; // manager record removed
    if (!this.isManagerAlive(sessionId)) return; // a closed manager never reschedules itself
    this.fire(record);
  }

  private isManagerAlive(sessionId: string): boolean {
    const session = this.deps.sessions.get(sessionId);
    return session !== undefined && session.state !== 'closed';
  }

  private fire(record: ManagerRecord): void {
    // Goes through the ordinary message queue, exactly like a message from a parent or sibling: if the
    // manager is mid-turn or waiting on a human, the pulse queues and is flushed on its next idle turn —
    // it never interrupts a running tool or answers a permission prompt.
    this.deps.sessions.sendMessage({ sessionId: record.sessionId, body: PULSE_MESSAGE });
    const pulsedAt = new Date().toISOString();
    this.deps.managers.setLastPulseAt(record.sessionId, pulsedAt);
    const updated: ManagerRecord = { ...record, lastPulseAt: pulsedAt };
    const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
    this.deps.bus.emit({ type: 'manager.pulsed', manager: toManagerView(updated, childrenCount) });
    this.arm(updated);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
