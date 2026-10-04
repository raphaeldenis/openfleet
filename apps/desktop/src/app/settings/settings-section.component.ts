import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A settings page: its heading, then the projected content spaced one rem apart. */
@Component({
  selector: 'of-settings-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" [attr.data-testid]="testId()">
      <h1>{{ heading() }}</h1>
      <ng-content />
    </section>
  `,
  styles: `
    .panel { max-width: 40rem; display: flex; flex-direction: column; gap: 1rem; }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
  `,
})
export class SettingsSectionComponent {
  readonly heading = input.required<string>();
  readonly testId = input.required<string>();
}
