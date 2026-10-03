import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { DataStore } from '@openfleet/shared';

@Component({
  selector: 'of-table-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (store of stores(); track store.id) {
      <button
        type="button"
        class="pill"
        [class.active]="store.id === activeStoreId()"
        [attr.data-testid]="'table-pill-' + store.id"
        [attr.aria-pressed]="store.id === activeStoreId()"
        (click)="selected.emit(store.id)"
      >{{ store.displayName }}</button>
    }
    <button type="button" class="add" data-testid="table-add" aria-label="New table" (click)="addRequested.emit()">+</button>
  `,
  styles: `
    :host { display: flex; gap: .25rem; min-width: 0; overflow-x: auto }
    .pill, .add {
      height: 1.625rem; display: flex; align-items: center; white-space: nowrap; padding: 0 .625rem;
      border: 0; border-radius: .375rem; background: transparent; color: var(--fg);
      font: inherit; font-size: .75rem; cursor: pointer;
    }
    .pill.active { background: var(--active) }
    .add { padding: 0 .5rem; color: var(--mut) }
    .pill:focus-visible, .add:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
  `,
})
export class TableListComponent {
  readonly stores = input.required<DataStore[]>();
  readonly activeStoreId = input<string | null>(null);
  readonly selected = output<string>();
  readonly addRequested = output<void>();
}
