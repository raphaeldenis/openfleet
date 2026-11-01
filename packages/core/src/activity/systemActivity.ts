import type { Session } from '@openfleet/shared';
import type { ActivityRecorder } from './activityRecorder.js';

/** The actions the daemon takes on its own, each recorded as one system row. */
export class SystemActivity {
  constructor(private readonly recorder: Pick<ActivityRecorder, 'record'>) {}

  daemonStarted(version: string): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'daemon', source: 'daemon', action: 'daemon.start', outcome: 'ok', detail: version });
  }

  /** The pulse is filed under the root of the lineage of the manager pulsed, like the MCP actions of its sessions. */
  pulseSent({ managerSessionId, lineageRootId }: { managerSessionId: string; lineageRootId: string }): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'scheduler', source: 'daemon', action: 'pulse.sent', sessionId: managerSessionId, managerId: lineageRootId, outcome: 'ok' });
  }

  sessionResumed(session: Pick<Session, 'id' | 'name'>, managerId: string): void {
    this.recorder.record({
      actorKind: 'system', actorLabel: 'daemon', source: 'daemon', action: 'session.resume', sessionId: session.id, managerId,
      entityKind: 'session', entityId: session.id, entityLabel: session.name, outcome: 'ok',
    });
  }
}
