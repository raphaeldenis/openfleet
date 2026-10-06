import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { DsColumn, DsRow } from '@openfleet/shared';
import { TableCellComponent } from './table-cell.component';
import { canEditCell, type CellEditRequest } from './table-cell-editor-values';
import { sortedColumns } from './table-cells';

@Component({
  selector: 'of-row-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TableCellComponent],
  template: `
    <section aria-label="Row details">
      <h2>Row details</h2>
      @for (column of orderedColumns(); track column.id) {
        <div class="field">
          <span>{{ column.displayName }}</span>
          <of-table-cell [column]="column" [value]="row().data[column.id]" [expanded]="true" />
          @if (column.autoValue) { <span>Set automatically</span> }
          @if (!readonly() && canEdit(column)) {
            <button type="button" (click)="editRequested.emit({ rowId: row().id, column, trigger: $any($event.currentTarget) })">Edit {{ column.displayName }}</button>
          }
        </div>
      }
    </section>
  `,
  styles: `section, .field { display: flex; flex-direction: column; gap: .375rem } section { padding: .75rem .875rem; border-bottom: .0625rem solid var(--line) } h2 { font-size: .875rem; margin: 0 } .field { font-size: .75rem; overflow-wrap: anywhere } button { align-self: flex-start; font: inherit }`,
})
export class RowDetailsComponent {
  readonly row = input.required<DsRow>();
  readonly columns = input.required<DsColumn[]>();
  readonly readonly = input(false);
  readonly editRequested = output<CellEditRequest>();
  protected readonly canEdit = canEditCell;
  protected orderedColumns(): DsColumn[] { return sortedColumns(this.columns()); }
}
