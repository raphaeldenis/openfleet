import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ageLabel } from './note-age';
import type { NoteSummary } from './notes.types';

@Component({
  selector: 'of-note-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <input
        class="filter"
        type="search"
        placeholder="Filter notes"
        aria-label="Filter notes"
        data-testid="note-list-filter"
        [value]="filter()"
        (input)="filter.set($any($event.target).value)"
      />
      <button type="button" class="new" title="New note" aria-label="New note" data-testid="note-list-new" (click)="create.emit()">+</button>
    </div>
    <div class="items">
      @for (note of visibleNotes(); track note.id) {
        <button
          type="button"
          class="item"
          [attr.data-testid]="'note-list-item-' + note.id"
          [attr.aria-current]="note.id === selectedId() ? 'true' : null"
          (click)="selected.emit(note.id)"
        >
          <span class="title">{{ note.title }}</span>
          <span class="meta">{{ ageOf(note) }}</span>
        </button>
      }
      @if (notes().length === 0) {
        <div class="hint" data-testid="note-list-empty">No notes yet.</div>
      } @else if (visibleNotes().length === 0) {
        <div class="hint" data-testid="note-list-no-match">No note matches “{{ filter() }}”.</div>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; width: 15rem; flex: none; border-right: 1px solid var(--line); background: var(--panel) }
    .toolbar { display: flex; align-items: center; gap: .5rem; padding: .625rem .75rem; border-bottom: 1px solid var(--line) }
    .filter {
      flex: 1; min-width: 0; height: 1.625rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem;
      background: var(--sunk); color: var(--fg); font: inherit; font-size: .75rem; outline: 0;
    }
    .filter:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .new {
      width: 1.625rem; height: 1.625rem; border: 1px solid var(--line); border-radius: .375rem;
      background: var(--panel); color: var(--fg); cursor: pointer; font: inherit;
    }
    .new:focus-visible, .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .items { flex: 1; min-height: 0; overflow: auto; padding: .375rem; display: flex; flex-direction: column }
    .item {
      display: flex; flex-direction: column; gap: .0625rem; padding: .4375rem .5rem; border: 0; border-radius: .375rem;
      background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .item[aria-current='true'] { background: var(--active) }
    .item:hover:not([aria-current='true']) { background: var(--hover) }
    .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .meta { font-size: .6875rem; color: var(--mut) }
    .hint { padding: 1rem .5rem; font-size: .75rem; color: var(--mut) }
  `,
})
export class NoteListComponent {
  readonly notes = input.required<readonly NoteSummary[]>();
  readonly selectedId = input<string | null>(null);
  readonly selected = output<string>();
  readonly create = output<void>();

  protected readonly filter = signal('');
  protected readonly visibleNotes = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return this.notes().filter((note) => note.title.toLowerCase().includes(needle));
  });

  protected ageOf(note: NoteSummary): string {
    return ageLabel(note.updatedAt);
  }
}
