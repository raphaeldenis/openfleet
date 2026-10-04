import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** One settings row: a name with an optional description on the left, the projected value or button on the right. */
@Component({
  selector: 'of-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="label">
      <span class="name">{{ name() }}</span>
      @if (detail(); as description) {
        <span class="detail">{{ description }}</span>
      }
    </div>
    <ng-content />
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
    :host(:last-child) { border-bottom: 0; }
    .label { flex: 1; display: flex; flex-direction: column; }
    .name { font-weight: 500; }
    .detail { font-size: .75rem; color: var(--mut); }
  `,
})
export class SettingsRowComponent {
  readonly name = input.required<string>();
  readonly detail = input<string>();
}
