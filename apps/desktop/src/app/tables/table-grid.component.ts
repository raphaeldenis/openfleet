import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { DsColumn, DsRow } from '@openfleet/shared';
import { cellText, sortedColumns } from './table-cells';

@Component({
  selector: 'of-table-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid" role="table">
      <div class="header" role="row">
        @for (column of orderedColumns(); track column.id) {
          <span class="cell" role="columnheader" [attr.data-testid]="'grid-header-' + column.id">{{ column.displayName }}</span>
        }
      </div>
      @for (row of rows(); track row.id) {
        <div
          class="row"
          role="row"
          tabindex="0"
          [class.selected]="row.id === selectedRowId()"
          [attr.data-testid]="'grid-row-' + row.id"
          [attr.aria-selected]="row.id === selectedRowId()"
          (click)="rowSelected.emit(row.id)"
          (keydown.enter)="rowSelected.emit(row.id)"
        >
          @for (column of orderedColumns(); track column.id) {
            <span class="cell" role="cell" [attr.data-testid]="'grid-cell-' + row.id + '-' + column.id">{{ text(column, row) }}</span>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .grid { border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); overflow: hidden }
    .header {
      display: flex; padding: 0 .75rem; height: 2rem; align-items: center;
      border-bottom: 1px solid var(--line); background: var(--sunk);
      font-size: .6875rem; color: var(--mut); font-weight: 500;
    }
    .row {
      display: flex; padding: 0 .75rem; min-height: 2.25rem; align-items: center;
      border-bottom: 1px solid var(--line); cursor: pointer; font-size: .75rem;
    }
    .row.selected { background: var(--accent-bg) }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .cell { flex: 1 1 0; min-width: 0; padding-right: .5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  `,
})
export class TableGridComponent {
  readonly columns = input.required<DsColumn[]>();
  readonly rows = input.required<DsRow[]>();
  readonly selectedRowId = input<string | null>(null);
  readonly rowSelected = output<string>();

  protected readonly orderedColumns = computed(() => sortedColumns(this.columns()));
  protected readonly text = cellText;
}
