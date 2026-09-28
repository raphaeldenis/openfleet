import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { PermissionMode, Session, SessionState } from '@openfleet/shared';
import { FleetEventsService } from './fleet-events.service';

export type RequestKind = 'model' | 'permissionMode' | 'close' | 'interrupt' | 'resume' | 'renameName' | 'renameEmoji';

interface SessionRequest {
  sessionId: string;
  kind: RequestKind;
}

interface SessionRequestToRun extends SessionRequest {
  message: string | ((error: unknown) => string);
  action: () => Promise<unknown>;
}

interface LastSeen {
  model: string | undefined;
  permissionMode: PermissionMode | undefined;
  state: SessionState;
}

export const requestKeyOf = ({ sessionId, kind }: SessionRequest) => `${sessionId}:${kind}`;

/**
 * Each session's requests (switch model, close, reopen…) by kind. Being a root service, a request in flight and
 * a request's failure outlive the component that sent it: a view left and re-entered mid-request still reads as
 * busy, a second run of that kind for that session is skipped meanwhile, and the failure waits for the user's return.
 * A failure is dropped once what it concerned has moved on: the daemon reports another model or permission mode,
 * the session closes (its close and interrupt failures, its switch failures) or lives again (its resume failure).
 */
@Injectable({ providedIn: 'root' })
export class SessionRequestsService {
  private readonly keysInFlight = signal<ReadonlySet<string>>(new Set());
  private readonly errorsByKey = signal<ReadonlyMap<string, string>>(new Map());
  private readonly lastSeenBySession = new Map<string, LastSeen>();

  constructor() {
    const events = inject(FleetEventsService);
    effect(() => {
      const sessions = events.sessions();
      this.errorsByKey();
      untracked(() => sessions.forEach((session) => this.dropErrorsThatNoLongerApplyTo(session)));
    });
  }

  isBusy(sessionId: string, kind: RequestKind): boolean {
    return this.keysInFlight().has(requestKeyOf({ sessionId, kind }));
  }

  errorOf(sessionId: string, kind: RequestKind): string | null {
    return this.errorsByKey().get(requestKeyOf({ sessionId, kind })) ?? null;
  }

  clearError(sessionId: string, kind: RequestKind): void {
    this.setError({ sessionId, kind }, null);
  }

  /** Runs `action` unless that session already has a request of that kind in flight; a failure is kept as `message`, never the thrown error's own text. */
  async run({ sessionId, kind, message, action }: SessionRequestToRun): Promise<void> {
    const request = { sessionId, kind };
    if (this.isBusy(sessionId, kind)) return;
    this.setInFlight(request, true);
    this.setError(request, null);
    try {
      await action();
    } catch (thrown) {
      this.setError(request, typeof message === 'function' ? message(thrown) : message);
    } finally {
      this.setInFlight(request, false);
    }
  }

  private dropErrorsThatNoLongerApplyTo(session: Session): void {
    const { id: sessionId } = session;
    const before = this.lastSeenBySession.get(sessionId);
    this.lastSeenBySession.set(sessionId, { model: session.model, permissionMode: session.permissionMode, state: session.state });
    const isClosed = session.state === 'closed';
    const hasJustClosed = isClosed && before !== undefined && before.state !== 'closed';
    const hasModelMoved = before !== undefined && before.model !== session.model;
    const hasPermissionModeMoved = before !== undefined && before.permissionMode !== session.permissionMode;
    if (hasJustClosed || hasModelMoved) this.clearError(sessionId, 'model');
    if (hasJustClosed || hasPermissionModeMoved) this.clearError(sessionId, 'permissionMode');
    if (isClosed) {
      this.clearError(sessionId, 'close');
      this.clearError(sessionId, 'interrupt');
    } else {
      this.clearError(sessionId, 'resume');
    }
  }

  private setInFlight(request: SessionRequest, isInFlight: boolean): void {
    const keys = new Set(this.keysInFlight());
    if (isInFlight) keys.add(requestKeyOf(request));
    else keys.delete(requestKeyOf(request));
    this.keysInFlight.set(keys);
  }

  private setError(request: SessionRequest, error: string | null): void {
    const errors = new Map(this.errorsByKey());
    const key = requestKeyOf(request);
    const isAlreadyClear = error === null && !errors.has(key);
    if (isAlreadyClear) return;
    if (error === null) errors.delete(key);
    else errors.set(key, error);
    this.errorsByKey.set(errors);
  }
}
