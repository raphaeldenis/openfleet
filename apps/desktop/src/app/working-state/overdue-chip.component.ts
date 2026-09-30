import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { injectOverdue } from './working-state-overdue';

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
  protected readonly overdue = injectOverdue(() => this.session());
}
