import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'of-error-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (glyph()) {<span class="glyph" aria-hidden="true">✕&nbsp;</span>}<ng-content />`,
  styles: `
    :host { font-size: .75rem; color: var(--fg); }
    .glyph { color: var(--state-error); }
  `,
})
export class ErrorLineComponent {
  readonly glyph = input(true);
}
