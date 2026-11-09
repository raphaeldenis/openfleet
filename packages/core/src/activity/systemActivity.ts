import type { Session, TriggerFireReason } from '@openfleet/shared';
import type { ActivityRecorder } from './activityRecorder.js';

/** The reasons a fire is held back by a rule, as opposed to failing to run. */
const REASONS_OF_A_HELD_BACK_FIRE: readonly TriggerFireReason[] = ['cooldown', 'daily_cap', 'breaker_open', 'chain_depth', 'batched', 'superseded', 'stale', 'disarmed'];

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

  /** A fire settled: the id of the trigger only. A fire the policy or the breaker held back is `denied`, one that could not run is `error`. */
  triggerFired({ triggerId, ledgerState, reason }: { triggerId: string; ledgerState: 'completed' | 'cancelled'; reason?: TriggerFireReason }): void {
    const isHeldBack = reason !== undefined && REASONS_OF_A_HELD_BACK_FIRE.includes(reason);
    const outcome = ledgerState === 'completed' ? 'ok' : isHeldBack ? 'denied' : 'error';
    this.recorder.record({ actorKind: 'system', actorLabel: 'triggers', source: 'daemon', action: 'trigger.fired', entityKind: 'trigger', entityId: triggerId, outcome });
  }

  /** A table change was not offered to a trigger because the message of that same trigger set its author going: the id of the trigger only. */
  triggerOfferSuppressed({ triggerId }: { triggerId: string }): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'triggers', source: 'daemon', action: 'trigger.offer_suppressed', entityKind: 'trigger', entityId: triggerId, outcome: 'denied' });
  }

  /** A playbook run is journaled as started: the id of the run only, never an input or an output. */
  playbookRunStarted({ runId }: { runId: string; playbookId: string }): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'playbooks', source: 'daemon', action: 'playbook.run.started', entityKind: 'playbook_run', entityId: runId, outcome: 'ok' });
  }

  /** A playbook run settled: the id of the run and whether it succeeded. A run that failed or needs a review is an `error`. */
  playbookRunEnded({ runId, status }: { runId: string; playbookId: string; status: 'succeeded' | 'failed' | 'needs_review' }): void {
    this.recorder.record({ actorKind: 'system', actorLabel: 'playbooks', source: 'daemon', action: 'playbook.run.ended', entityKind: 'playbook_run', entityId: runId, outcome: status === 'succeeded' ? 'ok' : 'error' });
  }

  sessionResumed(session: Pick<Session, 'id' | 'name'>, managerId: string): void {
    this.recorder.record({
      actorKind: 'system', actorLabel: 'daemon', source: 'daemon', action: 'session.resume', sessionId: session.id, managerId,
      entityKind: 'session', entityId: session.id, entityLabel: session.name, outcome: 'ok',
    });
  }
}
