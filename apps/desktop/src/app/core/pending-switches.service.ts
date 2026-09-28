import { effect, inject, Injectable } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { FleetEventsService } from './fleet-events.service';

export type SwitchKind = 'model' | 'permissionMode';

export type SwitchStatus = 'relaunching' | 'deferred';

export interface PendingSwitch {
  /** `null` while the daemon has not answered the request yet. */
  status: SwitchStatus | null;
  requestedValue: string;
  valueBeforeSwitch: string | null;
  stateBeforeSwitch: SessionState | undefined;
  sawStartingSinceSwitch: boolean;
}

/** What a selector component knows about its switch at the moment it leaves a session: nothing pending when `valueBeforeSwitch` is undefined. */
export interface SwitchSnapshot {
  status: SwitchStatus | null;
  requestedValue: string;
  /** `undefined` means no switch is being tracked; `null` is a switch made from an unset value. */
  valueBeforeSwitch: string | null | undefined;
  stateBeforeSwitch: SessionState | undefined;
  sawStartingSinceSwitch: boolean;
}

export const NO_SWITCH_TRACKED = {
  status: null,
  valueBeforeSwitch: undefined,
  stateBeforeSwitch: undefined,
  sawStartingSinceSwitch: false,
} as const satisfies Omit<SwitchSnapshot, 'requestedValue'>;

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
      for (const session of sessions) this.followSessionState(session.id, session.state);
    });
  }

  // Mirrors what a selector does while it is mounted: a relaunch that starts and finishes while no selector shows
  // the session must still count as settled on return. A switch requested during a launch waits for it to end,
  // and only a 'starting' entered after that is its own relaunch.
  private followSessionState(sessionId: string, state: SessionState): void {
    const switches = this.switchesBySession.get(sessionId);
    if (!switches) return;
    for (const pending of Object.values(switches)) {
      if (!pending) continue;
      const wasRequestedDuringLaunch = pending.stateBeforeSwitch === 'starting';
      if (state === 'starting') {
        if (!wasRequestedDuringLaunch) pending.sawStartingSinceSwitch = true;
        continue;
      }
      const isEarlierLaunchOver = wasRequestedDuringLaunch && !pending.sawStartingSinceSwitch && state !== 'closed';
      if (isEarlierLaunchOver) pending.stateBeforeSwitch = state;
    }
  }

  recall(sessionId: string, kind: SwitchKind): PendingSwitch | undefined {
    return this.switchesBySession.get(sessionId)?.[kind];
  }

  /** Stores the snapshot as the session's pending switch of that kind, or forgets the kind when no switch is tracked. */
  park(sessionId: string, kind: SwitchKind, snapshot: SwitchSnapshot): void {
    const { valueBeforeSwitch } = snapshot;
    const isSwitchTracked = valueBeforeSwitch !== undefined;
    if (isSwitchTracked) this.store(sessionId, kind, { ...snapshot, valueBeforeSwitch });
    else this.forget(sessionId, kind);
  }

  /** Records the daemon's answer for a switch parked while its request was still in flight; a session gone from the fleet ignores it. */
  answer(sessionId: string, kind: SwitchKind, status: SwitchStatus): void {
    const pending = this.recall(sessionId, kind);
    if (pending) this.store(sessionId, kind, { ...pending, status });
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
