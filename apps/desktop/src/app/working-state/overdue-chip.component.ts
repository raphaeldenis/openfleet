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
        [class.compact]="compact()"
        data-testid="overdue-chip"
        [attr.role]="compact() ? 'img' : null"
        [attr.data-reason]="overdue.reason"
        [attr.title]="overdue.explanation"
        [attr.aria-label]="'state overdue: ' + overdue.explanation"
      ><span aria-hidden="true">!</span>@if (!compact()) {state overdue}</span>
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
    .chip.compact { justify-content: center; width: 1.25rem; padding: 0; border-radius: 50%; }
  `,
})
export class OverdueChipComponent {
  readonly session = input.required<Session>();
  readonly compact = input(false);
  protected readonly overdue = injectOverdue(() => this.session());
}
