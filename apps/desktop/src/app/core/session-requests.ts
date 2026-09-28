import { Injectable, signal } from '@angular/core';

export type RequestKind = 'model' | 'permissionMode' | 'close' | 'interrupt' | 'resume';

interface SessionRequest {
  sessionId: string;
  kind: RequestKind;
}

interface SessionRequestToRun extends SessionRequest {
  message: string | ((error: unknown) => string);
  action: () => Promise<unknown>;
}

const keyOf = ({ sessionId, kind }: SessionRequest) => `${sessionId}:${kind}`;

/**
 * Each session's requests (switch model, close, reopen…) by kind. Being a root service, a request in flight and
 * a request's failure outlive the component that sent it: a view left and re-entered mid-request still reads as
 * busy, a second run of that kind for that session is skipped meanwhile, and the failure waits for the user's return.
 */
@Injectable({ providedIn: 'root' })
export class SessionRequestsService {
  private readonly keysInFlight = signal<ReadonlySet<string>>(new Set());
  private readonly errorsByKey = signal<ReadonlyMap<string, string>>(new Map());

  isBusy(sessionId: string, kind: RequestKind): boolean {
    return this.keysInFlight().has(keyOf({ sessionId, kind }));
  }

  errorOf(sessionId: string, kind: RequestKind): string | null {
    return this.errorsByKey().get(keyOf({ sessionId, kind })) ?? null;
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

  private setInFlight(request: SessionRequest, isInFlight: boolean): void {
    const keys = new Set(this.keysInFlight());
    if (isInFlight) keys.add(keyOf(request));
    else keys.delete(keyOf(request));
    this.keysInFlight.set(keys);
  }

  private setError(request: SessionRequest, error: string | null): void {
    const errors = new Map(this.errorsByKey());
    if (error === null) errors.delete(keyOf(request));
    else errors.set(keyOf(request), error);
    this.errorsByKey.set(errors);
  }
}
