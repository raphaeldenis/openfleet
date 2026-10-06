import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DsColumn } from '@openfleet/shared';
import { clickableUrl, displayValue } from './table-cells';

@Component({
  selector: 'of-table-cell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as href) {
      <a [href]="href" target="_blank" rel="noopener noreferrer" [attr.title]="text()"
        (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">{{ text() }}</a>
    } @else {
      <span [class.multiline]="column().format === 'longText'" [attr.title]="text()">{{ text() }}</span>
    }
  `,
  styles: `
    :host { min-width: 0 }
    a { color: var(--accent); overflow-wrap: anywhere }
    a:focus-visible { outline: .125rem solid var(--accent); outline-offset: .125rem }
    .multiline {
      white-space: pre-wrap; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
    }
  `,
})
export class TableCellComponent {
  readonly column = input.required<DsColumn>();
  readonly value = input.required<unknown>();
  protected readonly text = computed(() => displayValue(this.column(), this.value()));
  protected readonly url = computed(() => clickableUrl(this.column(), this.value()));
}
