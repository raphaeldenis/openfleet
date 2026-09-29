import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { DsColumn, DsRowChange, DsRowHistoryEntry } from '@openfleet/shared';
import { ActorBadgeComponent } from './actor-badge.component';
import { displayValue } from './table-cells';

const EMPTY_VALUE = '—';

const formatValue = (value: unknown) => (value === null || value === undefined ? EMPTY_VALUE : typeof value === 'object' ? JSON.stringify(value) : String(value));

@Component({
  selector: 'of-row-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorBadgeComponent, DatePipe],
  template: `
    @if (heading(); as title) {
      <div class="heading" data-testid="history-heading">{{ title }}</div>
    }
    <div class="section-title of-section-title">Row history</div>
    @for (entry of entries(); track entry.id) {
      <div class="entry" [attr.data-testid]="'history-entry-' + entry.id">
        <div class="body">
          <span>
            <b class="who">{{ entry.actorLabel }}</b>
            <of-actor-badge [kind]="entry.actorKind" />
            <span class="what">{{ describe(entry.change) }}</span>
          </span>
          <span class="when">{{ entry.createdAt | date: 'MMM d, HH:mm' }}</span>
        </div>
      </div>
    } @empty {
      <div class="empty" data-testid="history-empty">No recorded changes for this row.</div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column }
    .heading { padding: .75rem .875rem; border-bottom: 1px solid var(--line); font-weight: 600 }
    .section-title { padding: .5rem .875rem }
    .entry { display: flex; padding: .375rem .875rem; font-size: .75rem }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column }
    .who { font-weight: 500 }
    .what { color: var(--mut) }
    .when { font-family: var(--mono); font-size: .625rem; color: var(--faint) }
    .empty { padding: .375rem .875rem; font-size: .75rem; color: var(--mut) }
  `,
})
export class RowHistoryComponent {
  readonly entries = input.required<DsRowHistoryEntry[]>();
  readonly columns = input<DsColumn[]>([]);
  readonly heading = input<string | null>(null);

  private readonly columnNameById = computed(() => new Map(this.columns().map((column) => [column.id, column.displayName])));

  protected describe(change: DsRowChange): string {
    if ('kind' in change && change.kind === 'create') return 'created row';
    if ('kind' in change && change.kind === 'delete') return 'deleted row';
    const fieldChanges = change as Record<string, { from: unknown; to: unknown }>;
    return Object.entries(fieldChanges)
      .map(([columnId, { from, to }]) => `${this.columnNameById().get(columnId) ?? columnId} ${this.format(columnId, from)} → ${this.format(columnId, to)}`)
      .join(', ');
  }

  private format(columnId: string, value: unknown): string {
    const column = this.columns().find((candidate) => candidate.id === columnId);
    const shownValue = column ? displayValue(column, value) : formatValue(value);
    return shownValue === '' ? EMPTY_VALUE : shownValue;
  }
}
