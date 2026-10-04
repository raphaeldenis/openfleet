import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

/** A row whose setting does not exist in this build: the value is drawn disabled and the reason is shown. */
export interface UnavailableSetting {
  reason: string;
  value: string;
  testId: string;
}

let nextReasonSequence = 0;

/** One settings row: a name with an optional description on the left, the projected value or button on the right; an unavailable row draws its own disabled value and reason. */
@Component({
  selector: 'of-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="label">
      <span class="name">{{ name() }}</span>
      @if (detail(); as description) {
        <span class="detail">{{ description }}</span>
      }
      @if (unavailable(); as setting) {
        <span class="reason" [id]="reasonId"><span class="dot" aria-hidden="true"></span>{{ setting.reason }}</span>
      }
    </div>
    @if (unavailable(); as setting) {
      <button type="button" class="value unavailable" disabled aria-disabled="true" [attr.data-testid]="setting.testId" [attr.title]="setting.reason" [attr.aria-describedby]="reasonId">{{ setting.value }}</button>
    } @else {
      <ng-content />
    }
  `,
  styles: `
    ${SETTINGS_VALUE_STYLES}
    :host { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
    :host(:last-child) { border-bottom: 0; }
    .label { flex: 1; display: flex; flex-direction: column; }
    .name { font-weight: 500; }
    .detail { font-size: .75rem; color: var(--mut); }
    .reason { display: flex; align-items: center; gap: .375rem; font-size: .75rem; color: var(--mut); }
    .dot { width: .375rem; height: .375rem; border-radius: 50%; background: var(--state-closed); }
    button.unavailable { border-width: 1px; border-style: dashed; border-color: var(--line-2); opacity: .6; cursor: not-allowed; }
  `,
})
export class SettingsRowComponent {
  readonly name = input.required<string>();
  readonly detail = input<string>();
  readonly unavailable = input<UnavailableSetting>();

  protected readonly reasonId = `settings-row-reason-${nextReasonSequence++}`;
}
