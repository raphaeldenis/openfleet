import { ChangeDetectionStrategy, Component, input, linkedSignal } from '@angular/core';
import { readGroupOpenPreference, writeGroupOpenPreference } from './sidebar-group-open-preference';

/** A sidebar group: a caret header that collapses its body, a short summary on the right and room for header actions. */
@Component({
  selector: 'of-sidebar-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.flex]': 'hostFlex()' },
  template: `
    <div class="header">
      <button type="button" class="toggle" [attr.aria-expanded]="isOpen()" [title]="toggleTip()" (click)="toggle()">
        <span class="caret" aria-hidden="true">{{ isOpen() ? '▾' : '▸' }}</span>
        <span class="title">{{ title() }}</span>
      </button>
      @if (summary(); as summaryText) {
        <span class="summary">{{ summaryText }}</span>
      }
      <ng-content select="[groupAction]" />
    </div>
    @if (isOpen()) {
      <div class="body" [style.max-height]="bodyMaxHeight()"><ng-content /></div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--line); }
    .header { flex: none; display: flex; align-items: center; gap: .375rem; height: 1.875rem; padding: 0 .75rem; color: var(--mut); }
    .toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: .375rem; height: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; text-align: left; cursor: pointer; }
    .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .caret { width: .625rem; }
    .summary { font-family: var(--mono); font-size: .6875rem; }
    .body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
  `,
})
export class SidebarGroupComponent {
  readonly groupKey = input.required<string>();
  readonly title = input.required<string>();
  readonly summary = input<string>('');
  /** Share of the free sidebar height an open group takes; 0 sizes the group to its content. */
  readonly growWhenOpen = input(0);
  readonly bodyMaxHeight = input<string | null>(null);

  protected readonly isOpen = linkedSignal(() => readGroupOpenPreference(this.groupKey()));
  protected readonly toggleTip = () => `${this.isOpen() ? 'Collapse' : 'Expand'} ${this.title()}`;
  protected readonly hostFlex = () => (this.isOpen() && this.growWhenOpen() > 0 ? `${this.growWhenOpen()} 1 0` : 'none');

  protected toggle(): void {
    const isOpenNow = !this.isOpen();
    this.isOpen.set(isOpenNow);
    writeGroupOpenPreference(this.groupKey(), isOpenNow);
  }
}
