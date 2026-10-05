import { ChangeDetectionStrategy, Component, input } from '@angular/core';

const NOTHING_LINE = '(rien)';

@Component({
  selector: 'of-state-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="section" [attr.data-testid]="'state-section-' + sectionKey()">
      <h3 class="heading" data-testid="state-section-heading">{{ heading() }}</h3>
      @if (items().length > 0) {
        <ul class="items">
          @for (item of items(); track $index) {
            <li class="item" data-testid="state-item">{{ item }}</li>
          }
        </ul>
      } @else {
        <p class="empty" data-testid="state-section-empty">{{ nothingLine }}</p>
      }
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .section { display: flex; flex-direction: column; gap: .125rem; min-width: 0; }
    .heading { margin: 0; font-size: .6875rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--mut); }
    .items { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: .125rem; }
    .item { display: flex; gap: .375rem; font-size: .75rem; min-width: 0; overflow-wrap: anywhere; text-wrap: pretty; }
    .item::before { content: '–'; flex: none; color: var(--mut); }
    .empty { margin: 0; font-size: .75rem; color: var(--mut); }
  `,
})
export class StateSectionComponent {
  readonly sectionKey = input.required<string>();
  readonly heading = input.required<string>();
  readonly items = input.required<readonly string[]>();
  protected readonly nothingLine = NOTHING_LINE;
}
