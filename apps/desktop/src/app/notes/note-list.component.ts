import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, model, output, signal } from '@angular/core';
import { ageLabel } from './note-age';
import { displayTitleOf } from './note-title';
import type { NoteSummary } from '@openfleet/shared';

function destinationIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown': return Math.min(current + 1, count - 1);
    case 'ArrowUp': return Math.max(current - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

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
      <button
        type="button"
        class="new"
        title="New note"
        aria-label="New note"
        data-testid="note-list-new"
        [disabled]="!canCreate()"
        (click)="create.emit()"
      >+</button>
    </div>
    <div class="items" role="list" data-testid="note-list-items" (focusout)="forgetFocusedNoteWhenLeavingList($event)">
      @for (note of visibleNotes(); track note.id) {
        <div class="row" role="listitem">
          <button
            type="button"
            class="item"
            [attr.data-testid]="'note-list-item-' + note.id"
            [attr.aria-current]="note.id === selectedId() ? 'true' : null"
            [attr.tabindex]="note.id === tabStopId() ? 0 : -1"
            (click)="selected.emit(note.id)"
            (focus)="focusedId.set(note.id)"
            (keydown)="moveFocusWithArrowKeys($event)"
          >
            <span class="title">{{ displayTitleOf(note.title) }}</span>
            <span class="meta">{{ ageOf(note) }}</span>
          </button>
        </div>
      }
      @if (notes().length === 0) {
        @if (hasLoaded()) {
          <div class="hint" data-testid="note-list-empty">No notes yet.</div>
        }
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
    .row { display: flex; flex-direction: column }
    .item {
      display: flex; flex-direction: column; gap: .0625rem; padding: .4375rem .5rem; border: 0; border-radius: .375rem;
      background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .item[aria-current='true'] { background: var(--active) }
    .item:hover:not([aria-current='true']) { background: var(--hover) }
    .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .meta { font-size: .6875rem; color: var(--mut) }
    .hint { padding: 1rem .5rem; font-size: .75rem; color: var(--mut) }
    .new:disabled { color: var(--mut); cursor: not-allowed }
  `,
})
export class NoteListComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly notes = input.required<readonly NoteSummary[]>();
  readonly selectedId = input<string | null>(null);
  readonly hasLoaded = input(true);
  readonly canCreate = input(true);
  readonly filter = model('');
  readonly selected = output<string>();
  readonly create = output<void>();

  protected readonly visibleNotes = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return this.notes().filter((note) => note.title.toLowerCase().includes(needle));
  });

  protected readonly focusedId = signal<string | null>(null);
  protected readonly tabStopId = computed(() => {
    const shownIds = this.visibleNotes().map((note) => note.id);
    const preferredId = this.focusedId() ?? this.selectedId();
    const isPreferredShown = preferredId !== null && shownIds.includes(preferredId);
    return isPreferredShown ? preferredId : shownIds[0];
  });

  protected readonly displayTitleOf = displayTitleOf;

  /** Puts the focus on the note that is the list's tab stop, or on the filter when no note is shown. */
  focus(): void {
    const host: HTMLElement = this.host.nativeElement;
    const target = host.querySelector<HTMLElement>('.item[tabindex="0"]') ?? host.querySelector<HTMLElement>('.filter');
    target?.focus();
  }

  protected forgetFocusedNoteWhenLeavingList(event: FocusEvent): void {
    const list = event.currentTarget as HTMLElement;
    const focusStaysInList = event.relatedTarget instanceof Node && list.contains(event.relatedTarget);
    if (!focusStaysInList) this.focusedId.set(null);
  }

  protected moveFocusWithArrowKeys(event: KeyboardEvent): void {
    const items = [...(event.currentTarget as HTMLElement).closest('.items')!.querySelectorAll<HTMLElement>('.item')];
    const current = items.indexOf(event.currentTarget as HTMLElement);
    const destination = destinationIndex(event.key, current, items.length);
    if (destination === null) return;
    event.preventDefault();
    items[destination]?.focus();
  }

  protected ageOf(note: NoteSummary): string {
    return ageLabel(note.updatedAt);
  }
}
