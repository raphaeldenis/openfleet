import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ExternalLinks } from '../core/external-links.service';
import type { DsColumn } from '@openfleet/shared';
import { clickableUrl, displayValue } from './table-cells';

const MONOSPACED_COLUMN_NAME = /^(id|model)$/i;
const NEUTRAL_CHIP_COLOR = 'var(--mut)';

@Component({
  selector: 'of-table-cell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as href) {
      <a [href]="href" target="_blank" rel="noopener noreferrer" [attr.title]="text()"
        (click)="openLink(href, $event)" (keydown)="$event.stopPropagation()">{{ text() }}</a>
    } @else if (chipColor(); as color) {
      <span class="chip" [style.background]="'color-mix(in oklch, ' + color + ' 14%, transparent)'" [attr.title]="text()"><span class="chip-dot" data-testid="chip-dot" [style.background]="color"></span>{{ text() }}</span>
    } @else {
      <span [class.multiline]="column().format === 'longText'" [class.expanded]="expanded()" [style.font-family]="isMonospaced() ? 'var(--mono)' : null" [attr.title]="text()">{{ text() }}</span>
    }
  `,
  styles: `
    :host { min-width: 0 }
    .chip { display: inline-flex; align-items: center; gap: .25rem; padding: 0 .375rem; border-radius: .25rem; font-size: .6875rem; color: var(--fg) }
    .chip-dot { flex: none; width: .375rem; height: .375rem; border-radius: 50% }
    a { color: var(--accent); overflow-wrap: anywhere }
    a:focus-visible { outline: .125rem solid var(--accent); outline-offset: .125rem }
    .multiline {
      white-space: pre-wrap; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
    }
    .multiline.expanded { display: block; overflow: visible }
  `,
})
export class TableCellComponent {
  private readonly externalLinks = inject(ExternalLinks);
  protected openLink(url: string, event: MouseEvent): void {
    event.stopPropagation();
    this.externalLinks.open(url, event);
  }
  readonly column = input.required<DsColumn>();
  readonly value = input.required<unknown>();
  readonly expanded = input(false);
  protected readonly text = computed(() => displayValue(this.column(), this.value()));
  protected readonly isMonospaced = computed(() => MONOSPACED_COLUMN_NAME.test(this.column().displayName));
  protected readonly chipColor = computed(() => {
    const column = this.column();
    const isFilledSelect = column.columnType === 'select' && this.text() !== '';
    if (!isFilledSelect) return null;
    return column.options?.find((option) => option.id === this.value())?.color ?? NEUTRAL_CHIP_COLOR;
  });
  protected readonly url = computed(() => clickableUrl(this.column(), this.value()));
}
