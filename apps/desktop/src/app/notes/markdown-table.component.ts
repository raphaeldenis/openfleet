import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { InlineSegment, TableAlignment, TableCell } from './markdown-blocks';

/** Renders a parsed Markdown table: a header row, aligned columns and cells whose `<br>` lines stay separate; wide tables scroll sideways. */
@Component({
  selector: 'of-markdown-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scroll" role="region" tabindex="0" [attr.aria-label]="regionLabel()">
      <table>
        <thead>
          <tr>
            @for (cell of header(); track $index) {
              <th scope="col" [style.text-align]="alignments()[$index]"><ng-container [ngTemplateOutlet]="cellContent" [ngTemplateOutletContext]="{ $implicit: cell }" /></th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track $index) {
            <tr>
              @for (cell of row; track $index) {
                <td [style.text-align]="alignments()[$index]"><ng-container [ngTemplateOutlet]="cellContent" [ngTemplateOutletContext]="{ $implicit: cell }" /></td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>

    <ng-template #cellContent let-cell>
      @for (line of cell; track $index) {
        @if ($index > 0) { <br /> }
        @for (segment of line; track $index) {
          @if (segment.isCode) {
            <code>{{ segment.text }}</code>
          } @else if (segment.isBold) {
            <strong>{{ segment.text }}</strong>
          } @else { {{ segment.text }} }
        }
      }
    </ng-template>
  `,
  styles: `
    :host { display: block; min-width: 0 }
    .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: .375rem }
    .scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: inherit; line-height: 1.5 }
    th, td { padding: .375rem .625rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: normal }
    th { background: var(--sunk); font-weight: 600; white-space: nowrap }
    tbody tr:last-child td { border-bottom: 0 }
    td { min-width: 6rem; overflow-wrap: anywhere }
    code { font-family: var(--mono); font-size: .85em; padding: 0 .25rem; border-radius: .25rem; background: var(--sunk) }
    strong { font-weight: 600 }
  `,
  imports: [NgTemplateOutlet],
})
export class MarkdownTableComponent {
  readonly header = input.required<TableCell[]>();
  readonly rows = input.required<TableCell[][]>();
  readonly alignments = input.required<TableAlignment[]>();

  protected readonly regionLabel = computed(() => `Table: ${this.header().map(plainTextOf).join(', ')}`);
}

function plainTextOf(cell: TableCell): string {
  return cell.map((line) => line.map((segment: InlineSegment) => segment.text).join('')).join(' ');
}
