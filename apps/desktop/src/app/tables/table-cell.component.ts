import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ExternalLinks } from '../core/external-links.service';
import type { DsColumn } from '@openfleet/shared';
import { clickableUrl, displayValue } from './table-cells';

@Component({
  selector: 'of-table-cell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as href) {
      <a [href]="href" target="_blank" rel="noopener noreferrer" [attr.title]="text()"
        (click)="openLink(href, $event)" (keydown)="$event.stopPropagation()">{{ text() }}</a>
    } @else {
      <span [class.multiline]="column().format === 'longText'" [class.expanded]="expanded()" [attr.title]="text()">{{ text() }}</span>
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
  protected readonly url = computed(() => clickableUrl(this.column(), this.value()));
}
