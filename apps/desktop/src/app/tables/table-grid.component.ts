import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { DsColumn, DsRow } from '@openfleet/shared';
import { cellText, sortedColumns } from './table-cells';

@Component({
  selector: 'of-table-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid" role="table" data-testid="table-grid">
      <div class="header" role="row">
        @for (column of orderedColumns(); track column.id) {
          <span class="cell" role="columnheader" [attr.data-testid]="'grid-header-' + column.id">{{ column.displayName }}</span>
        }
      </div>
      @for (row of rows(); track row.id) {
        <div
          class="row"
          role="row"
          [attr.tabindex]="row.id === tabStopRowId() ? 0 : -1"
          [attr.data-row-id]="row.id"
          [class.selected]="row.id === selectedRowId()"
          [attr.data-testid]="'grid-row-' + row.id"
          [attr.aria-selected]="row.id === selectedRowId()"
          (click)="rowSelected.emit(row.id)"
          (focus)="focusedRowId.set(row.id)"
          (keydown.enter)="openFromKeyboard($event, row.id)"
          (keydown.space)="openFromKeyboard($event, row.id)"
          (keydown.arrowdown)="focusNeighbour($event, 'next')"
          (keydown.arrowup)="focusNeighbour($event, 'previous')"
        >
          @for (column of orderedColumns(); track column.id) {
            <span class="cell" role="cell" [attr.data-testid]="'grid-cell-' + row.id + '-' + column.id">{{ text(column, row) }}</span>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .grid { border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); overflow-x: auto; overflow-y: hidden }
    .header {
      display: flex; width: max-content; min-width: 100%; box-sizing: border-box; padding: 0 .75rem; height: 2rem; align-items: center;
      border-bottom: 1px solid var(--line); background: var(--sunk);
      font-size: .6875rem; color: var(--mut); font-weight: 500;
    }
    .row {
      display: flex; width: max-content; min-width: 100%; box-sizing: border-box; padding: 0 .75rem; min-height: 2.25rem; align-items: center;
      border-bottom: 1px solid var(--line); cursor: pointer; font-size: .75rem;
    }
    .row.selected { background: var(--accent-bg) }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .cell { flex: 1 1 8rem; min-width: 8rem; padding-right: .5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  `,
})
export class TableGridComponent {
  readonly columns = input.required<DsColumn[]>();
  readonly rows = input.required<DsRow[]>();
  readonly selectedRowId = input<string | null>(null);
  readonly rowSelected = output<string>();

  protected readonly focusedRowId = signal<string | null>(null);
  protected readonly tabStopRowId = computed(() => {
    const rowIds = this.rows().map((row) => row.id);
    const preferredRowId = this.focusedRowId() ?? this.selectedRowId();
    return preferredRowId && rowIds.includes(preferredRowId) ? preferredRowId : rowIds[0];
  });
  protected readonly orderedColumns = computed(() => sortedColumns(this.columns()));
  protected readonly text = cellText;

  protected openFromKeyboard(event: Event, rowId: string): void {
    event.preventDefault();
    this.rowSelected.emit(rowId);
  }

  protected focusNeighbour(event: Event, direction: 'next' | 'previous'): void {
    event.preventDefault();
    const row = event.currentTarget as HTMLElement;
    const neighbour = direction === 'next' ? row.nextElementSibling : row.previousElementSibling;
    (neighbour as HTMLElement | null)?.focus();
  }
}
