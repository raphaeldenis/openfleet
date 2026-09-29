import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { DsColumn, DsRow, SelectOption } from '@openfleet/shared';
import { cellText, textColumns, titleOf } from './table-cells';

export const NO_VALUE_GROUP_ID = '__no_value__';

export interface KanbanGroup {
  option: SelectOption;
  rows: DsRow[];
}

@Component({
  selector: 'of-table-kanban',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (group of groups(); track group.option.id) {
      <section class="column" [attr.data-testid]="'kanban-column-' + group.option.id">
        <header class="column-header">
          <span class="dot">●</span>
          <span class="label">{{ group.option.label }}</span>
          <span class="count" [attr.data-testid]="'kanban-count-' + group.option.id">{{ group.rows.length }}</span>
        </header>
        @for (row of group.rows; track row.id) {
          <button
            type="button"
            class="card"
            [attr.data-testid]="'kanban-card-' + row.id"
            [attr.data-row-id]="row.id"
            [attr.aria-pressed]="row.id === selectedRowId()"
            [class.selected]="row.id === selectedRowId()"
            (click)="rowSelected.emit(row.id)"
          >
            <span class="title">{{ titleOf(row) || untitledLabel }}</span>
            @if (detailsOf(row); as details) {
              <span class="details" [attr.title]="details" [attr.data-testid]="'kanban-details-' + row.id">{{ details }}</span>
            }
          </button>
        }
      </section>
    }
  `,
  styles: `
    :host { display: flex; gap: .75rem; align-items: flex-start }
    .column { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; padding: .5rem; border-radius: .5rem; background: var(--sunk) }
    .column-header { display: flex; gap: .375rem; padding: .125rem .25rem; font-size: .75rem; font-weight: 600 }
    .dot { color: var(--faint) }
    .label { flex: 1 }
    .count { color: var(--faint); font-weight: 400 }
    .card {
      display: flex; flex-direction: column; gap: .375rem; padding: .625rem; text-align: left;
      min-width: 0; max-height: 12rem; overflow: hidden;
      border: 1px solid var(--line); border-radius: .375rem; background: var(--panel); color: inherit;
      cursor: pointer; font: inherit; font-size: .75rem;
    }
    .card.selected { border-color: var(--accent); background: var(--accent-bg) }
    .card:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .title { font-weight: 500; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden }
    .details {
      color: var(--mut); font-size: .6875rem; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
    }
  `,
})
export class TableKanbanComponent {
  readonly columns = input.required<DsColumn[]>();
  readonly groups = input.required<KanbanGroup[]>();
  readonly selectedRowId = input<string | null>(null);
  readonly rowSelected = output<string>();

  protected readonly untitledLabel = 'Untitled';
  protected readonly titleOf = (row: DsRow) => titleOf(this.columns(), row);

  protected detailsOf(row: DsRow): string {
    const [, ...detailColumns] = textColumns(this.columns());
    return detailColumns.map((column) => cellText(column, row)).filter(Boolean).join(' · ');
  }
}
