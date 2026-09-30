import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { overdueExplanation, overdueReasonOf, tickingNow, type FreshnessRules } from './working-state-freshness';

@Component({
  selector: 'of-overdue-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (overdue(); as overdue) {
      <span
        class="chip"
        data-testid="overdue-chip"
        [attr.data-reason]="overdue.reason"
        [attr.title]="overdue.explanation"
        [attr.aria-label]="'state overdue: ' + overdue.explanation"
      ><span aria-hidden="true">!</span>state overdue</span>
    }
  `,
  styles: `
    :host(:empty) { display: none; }
    .chip {
      display: inline-flex; align-items: center; flex: none; gap: .375rem; height: 1.25rem; padding: 0 .5rem;
      border-radius: .375rem; font-family: var(--mono); font-size: .6875rem; font-weight: 500; color: var(--fg); white-space: nowrap;
      background: color-mix(in oklch, var(--state-waiting-permission) 14%, transparent);
    }
    .chip > span[aria-hidden] { color: var(--state-waiting-permission); }
  `,
})
export class OverdueChipComponent {
  readonly session = input.required<Session>();
  private readonly events = inject(FleetEventsService);
  private readonly now = tickingNow();

  protected readonly overdue = computed(() => {
    const isClosed = this.session().state === 'closed';
    if (isClosed || !this.events.workingStatesReported()) return undefined;
    const rules: FreshnessRules = { nowMs: this.now(), maxAgeMinutes: this.events.workingStateMaxAgeMinutes(), maxBytes: this.events.workingStateMaxBytes() };
    const state = this.events.workingStates().get(this.session().id);
    const reason = overdueReasonOf(state, rules);
    return reason ? { reason, explanation: overdueExplanation(reason, state, rules) } : undefined;
  });
}
