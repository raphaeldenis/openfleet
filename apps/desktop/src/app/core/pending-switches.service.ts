import { Injectable } from '@angular/core';
import type { SessionState } from '@openfleet/shared';

export type SwitchKind = 'model' | 'permissionMode';

export interface PendingSwitch {
  status: 'relaunching' | 'deferred';
  requestedValue: string;
  valueBeforeSwitch: string | null;
  stateBeforeSwitch: SessionState | undefined;
  sawStartingSinceSwitch: boolean;
}

/**
 * Remembers each session's in-flight model / permission-mode switch, so a selector component reused
 * across a session switch (or destroyed and recreated by navigation) shows it again on return.
 */
@Injectable({ providedIn: 'root' })
export class PendingSwitchesService {
  private readonly bySessionAndKind = new Map<string, PendingSwitch>();

  recall(sessionId: string, kind: SwitchKind): PendingSwitch | undefined {
    return this.bySessionAndKind.get(keyOf(sessionId, kind));
  }

  /** `undefined` forgets the switch: nothing is pending for this session any more. */
  remember(sessionId: string, kind: SwitchKind, pending: PendingSwitch | undefined): void {
    if (pending) this.bySessionAndKind.set(keyOf(sessionId, kind), pending);
    else this.bySessionAndKind.delete(keyOf(sessionId, kind));
  }
}

function keyOf(sessionId: string, kind: SwitchKind): string {
  return `${kind}:${sessionId}`;
}
