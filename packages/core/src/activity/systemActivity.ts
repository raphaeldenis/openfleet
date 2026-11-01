import type { Session } from '@openfleet/shared';
import type { ActivityRecorder } from './activityRecorder.js';

/** The actions the daemon takes on its own, each recorded as one system row. */
export class SystemActivity {
  constructor(private readonly recorder: Pick<ActivityRecorder, 'record'>) {}

  daemonStarted(version: string): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'daemon', source: 'daemon', action: 'daemon.start', outcome: 'ok', detail: `version ${version}` });
  }

  pulseSent(managerId: string): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'scheduler', source: 'daemon', action: 'pulse.sent', sessionId: managerId, managerId, outcome: 'ok' });
  }

  sessionResumed(session: Pick<Session, 'id' | 'name'>, managerId: string): void {
    this.recorder.record({
      actorKind: 'system', actorLabel: 'daemon', source: 'daemon', action: 'session.resume', sessionId: session.id, managerId,
      entityKind: 'session', entityId: session.id, entityLabel: session.name, outcome: 'ok',
    });
  }
}
