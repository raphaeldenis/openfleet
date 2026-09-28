import { effect, inject, Injectable } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { FleetEventsService } from './fleet-events.service';

export type SwitchKind = 'model' | 'permissionMode';

export interface PendingSwitch {
  status: 'relaunching' | 'deferred';
  requestedValue: string;
  valueBeforeSwitch: string | null;
  stateBeforeSwitch: SessionState | undefined;
  sawStartingSinceSwitch: boolean;
}

/** What a selector component knows about its switch at the moment it leaves a session: nothing pending when `status` is null. */
export interface SwitchSnapshot {
  status: PendingSwitch['status'] | null;
  requestedValue: string;
  /** `undefined` means no switch is being tracked; `null` is a switch made from an unset value. */
  valueBeforeSwitch: string | null | undefined;
  stateBeforeSwitch: SessionState | undefined;
  sawStartingSinceSwitch: boolean;
}

/**
 * Remembers each session's in-flight model / permission-mode switch, so a selector component reused
 * across a session switch (or destroyed and recreated by navigation) shows it again on return.
 * Forgets the switches of a session that is closed or gone from the fleet.
 */
@Injectable({ providedIn: 'root' })
export class PendingSwitchesService {
  private readonly switchesBySession = new Map<string, Partial<Record<SwitchKind, PendingSwitch>>>();

  constructor() {
    const events = inject(FleetEventsService);
    effect(() => {
      const sessions = events.sessions();
      const openSessionIds = new Set(sessions.filter((s) => s.state !== 'closed').map((s) => s.id));
      for (const sessionId of [...this.switchesBySession.keys()]) {
        if (!openSessionIds.has(sessionId)) this.switchesBySession.delete(sessionId);
      }
      for (const session of sessions) {
        if (session.state === 'starting') this.markRelaunchStarted(session.id);
      }
    });
  }

  // A relaunch that starts and finishes while no selector shows the session must still count as settled on return.
  private markRelaunchStarted(sessionId: string): void {
    const switches = this.switchesBySession.get(sessionId);
    if (!switches) return;
    for (const pending of Object.values(switches)) {
      if (pending) pending.sawStartingSinceSwitch = true;
    }
  }

  recall(sessionId: string, kind: SwitchKind): PendingSwitch | undefined {
    return this.switchesBySession.get(sessionId)?.[kind];
  }

  /** Stores the snapshot as the session's pending switch of that kind, or forgets the kind when nothing is pending. */
  park(sessionId: string, kind: SwitchKind, snapshot: SwitchSnapshot): void {
    const { status, valueBeforeSwitch } = snapshot;
    const isSwitchPending = status !== null && valueBeforeSwitch !== undefined;
    if (isSwitchPending) this.store(sessionId, kind, { ...snapshot, status, valueBeforeSwitch });
    else this.forget(sessionId, kind);
  }

  private store(sessionId: string, kind: SwitchKind, pending: PendingSwitch): void {
    this.switchesBySession.set(sessionId, { ...this.switchesBySession.get(sessionId), [kind]: pending });
  }

  private forget(sessionId: string, kind: SwitchKind): void {
    const { [kind]: _forgotten, ...remaining } = this.switchesBySession.get(sessionId) ?? {};
    if (Object.keys(remaining).length === 0) this.switchesBySession.delete(sessionId);
    else this.switchesBySession.set(sessionId, remaining);
  }
}
