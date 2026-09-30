import { computed, inject, type Signal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { overdueExplanation, overdueReasonOf, tickingNow, type FreshnessRules, type OverdueReason } from './working-state-freshness';

export interface Overdue {
  readonly reason: OverdueReason;
  readonly explanation: string;
}

/** Why the shown session's state is overdue, or undefined when it is fresh, the session is closed or the daemon reports no states. Call in an injection context. */
export function injectOverdue(session: () => Session): Signal<Overdue | undefined> {
  const events = inject(FleetEventsService);
  const now = tickingNow();
  return computed(() => {
    const isClosed = session().state === 'closed';
    if (isClosed || !events.workingStatesReported()) return undefined;
    const rules: FreshnessRules = { nowMs: now(), maxAgeMinutes: events.workingStateMaxAgeMinutes(), maxBytes: events.workingStateMaxBytes() };
    const state = events.workingStates().get(session().id);
    const reason = overdueReasonOf(state, rules);
    return reason ? { reason, explanation: overdueExplanation(reason, state, rules) } : undefined;
  });
}
