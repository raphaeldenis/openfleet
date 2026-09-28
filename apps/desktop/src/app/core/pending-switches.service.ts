import { DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { PermissionMode, Session, SessionState } from '@openfleet/shared';
import { FleetApiService } from './fleet-api.service';
import { FleetEventsService } from './fleet-events.service';
import { requestKeyOf, SessionRequestsService } from './session-requests';

export type SwitchKind = 'model' | 'permissionMode';

export type SwitchStatus = 'relaunching' | 'deferred';

export const SWITCH_STATUS_LABEL: Record<SwitchStatus, string> = {
  relaunching: 'restarting…',
  deferred: 'switch pending: happens when this turn ends',
};

// A relaunch takes about 2 s. A "restarting…" note still up after this long belongs to a relaunch the client never
// saw start (it landed before a render, or while the socket was down), so it leaves on its own.
const RELAUNCHING_NOTE_EXPIRY_MS = 30_000;

export interface PendingSwitch {
  sessionId: string;
  kind: SwitchKind;
  /** `null` while the daemon has not answered the request yet. */
  status: SwitchStatus | null;
  requestedValue: string;
  stateBeforeSwitch: SessionState | undefined;
  sawStartingSinceSwitch: boolean;
}

interface SwitchRoute {
  failureMessage: string;
  send: (api: FleetApiService, sessionId: string, value: string) => Promise<{ status: SwitchStatus }>;
}

const SWITCH_ROUTES: Record<SwitchKind, SwitchRoute> = {
  model: {
    failureMessage: 'Could not switch model — try again.',
    send: (api, sessionId, value) => api.updateModel(sessionId, value),
  },
  permissionMode: {
    failureMessage: 'Could not change permission mode — try again.',
    send: (api, sessionId, value) => api.updatePermissionMode(sessionId, value as PermissionMode),
  },
};

/**
 * Follows the pending switch through the session's states: returns it (moved on) while it is still pending, `null` once settled.
 * The daemon persists the value, and emits its change, before or while the relaunch it triggers is still starting, so the value
 * landing is no proof the switch is done: only the relaunch's own 'starting' followed by another state, or the turn ending, is.
 * A switch requested during a launch waits for that launch to end: only a 'starting' entered after it is the switch's own relaunch.
 */
function advance(pending: PendingSwitch, state: SessionState | undefined): PendingSwitch | null {
  const isSessionGone = state === undefined || state === 'closed';
  if (isSessionGone) return null;
  const wasRequestedDuringLaunch = pending.stateBeforeSwitch === 'starting';
  if (state === 'starting') {
    const isOwnRelaunch = !wasRequestedDuringLaunch;
    return isOwnRelaunch ? { ...pending, sawStartingSinceSwitch: true } : pending;
  }
  const isEarlierLaunchOver = wasRequestedDuringLaunch && !pending.sawStartingSinceSwitch;
  if (isEarlierLaunchOver) return { ...pending, stateBeforeSwitch: state };
  const isTurnOver = state === 'idle' && state !== pending.stateBeforeSwitch;
  const isSettled = pending.sawStartingSinceSwitch || isTurnOver;
  return isSettled ? null : pending;
}

/**
 * The model / permission-mode switch each session has in flight or waiting on the daemon, by kind: what was requested,
 * whether the daemon answered "restarting" or "deferred", and whether the session's relaunch or turn has since settled it.
 * Being a root service settled by one effect over the fleet's sessions, a reply, a failure or a relaunch that lands while
 * no component shows the session is already in place when one does.
 */
@Injectable({ providedIn: 'root' })
export class PendingSwitchesService {
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly requests = inject(SessionRequestsService);
  private readonly switchesByKey = signal<ReadonlyMap<string, PendingSwitch>>(new Map());
  private readonly expiryTimersByKey = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    effect(() => {
      const sessions = this.events.sessions();
      untracked(() => this.settleAgainst(sessions));
    });
    inject(DestroyRef).onDestroy(() => this.expiryTimersByKey.forEach((timer) => clearTimeout(timer)));
  }

  pendingOf(sessionId: string, kind: SwitchKind): PendingSwitch | undefined {
    return this.switchesByKey().get(requestKeyOf({ sessionId, kind }));
  }

  /**
   * Sends the switch and tracks it from the click, not from the reply: the daemon's state events can outrun the HTTP answer,
   * and a tracking that starts late would miss a relaunch that already ran. A failure drops the tracking, so the value in force shows again.
   */
  async request({ sessionId, kind, value }: { sessionId: string; kind: SwitchKind; value: string }): Promise<void> {
    const { failureMessage, send } = SWITCH_ROUTES[kind];
    await this.requests.run({
      sessionId,
      kind,
      message: failureMessage,
      action: async () => {
        const previous = this.pendingOf(sessionId, kind);
        this.remember({
          sessionId,
          kind,
          status: previous?.status ?? null,
          requestedValue: value,
          stateBeforeSwitch: this.events.sessions().find((s) => s.id === sessionId)?.state,
          sawStartingSinceSwitch: false,
        });
        try {
          const { status } = await send(this.api, sessionId, value);
          this.recordAnswer({ sessionId, kind, status });
        } catch (error) {
          this.dropAfterFailure({ sessionId, kind, previous });
          throw error;
        }
      },
    });
  }

  private recordAnswer({ sessionId, kind, status }: { sessionId: string; kind: SwitchKind; status: SwitchStatus }): void {
    const pending = this.pendingOf(sessionId, kind);
    const hasSettledAlready = pending === undefined;
    if (hasSettledAlready) return;
    this.remember({ ...pending, status });
  }

  private dropAfterFailure({ sessionId, kind, previous }: { sessionId: string; kind: SwitchKind; previous: PendingSwitch | undefined }): void {
    const hasSettledMeanwhile = this.pendingOf(sessionId, kind) === undefined;
    if (hasSettledMeanwhile) return;
    if (previous) this.remember(previous);
    else this.forget(sessionId, kind);
  }

  private settleAgainst(sessions: readonly Session[]): void {
    const stateBySessionId = new Map(sessions.map((session) => [session.id, session.state] as const));
    for (const pending of this.switchesByKey().values()) {
      const advanced = advance(pending, stateBySessionId.get(pending.sessionId));
      if (advanced === pending) continue;
      if (advanced === null) this.forget(pending.sessionId, pending.kind);
      else this.remember(advanced);
    }
  }

  private remember(pending: PendingSwitch): void {
    this.switchesByKey.update((all) => new Map(all).set(requestKeyOf(pending), pending));
    this.restartExpiry(pending);
  }

  private forget(sessionId: string, kind: SwitchKind): void {
    const key = requestKeyOf({ sessionId, kind });
    this.switchesByKey.update((all) => {
      const remaining = new Map(all);
      remaining.delete(key);
      return remaining;
    });
    this.stopExpiry(key);
  }

  private restartExpiry({ sessionId, kind, status }: PendingSwitch): void {
    const key = requestKeyOf({ sessionId, kind });
    this.stopExpiry(key);
    if (status !== 'relaunching') return;
    this.expiryTimersByKey.set(key, setTimeout(() => this.forget(sessionId, kind), RELAUNCHING_NOTE_EXPIRY_MS));
  }

  private stopExpiry(key: string): void {
    clearTimeout(this.expiryTimersByKey.get(key));
    this.expiryTimersByKey.delete(key);
  }
}
