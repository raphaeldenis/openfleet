import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { ageLabel } from './note-age';
import type { NoteVersionSummary } from './notes.types';

@Component({
  selector: 'of-note-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="title">History</div>
    <ul class="versions">
      @for (version of newestFirst(); track version.id) {
        <li>
          <button
            type="button"
            class="version"
            [attr.data-testid]="'note-history-version-' + version.rev"
            [attr.aria-selected]="version.rev === selectedRev()"
            (click)="selectedRev.set(version.rev)"
          >
            <span class="head">
              <span class="author">{{ version.author }}</span>
              <span class="when">{{ ageOf(version) }}</span>
            </span>
            <span class="rev">rev {{ version.rev }}</span>
          </button>
        </li>
      }
    </ul>
    <div class="actions">
      <button type="button" class="restore" data-testid="note-history-restore" [disabled]="!hasSelection() || hasRestored()" (click)="restoreSelected()">
        Restore selected version
      </button>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; width: 17rem; flex: none; border-left: 1px solid var(--line); background: var(--panel); overflow: auto }
    .title { padding: .625rem .875rem; border-bottom: 1px solid var(--line); font-weight: 600 }
    .versions { list-style: none; margin: 0; padding: 0 }
    .version {
      display: flex; flex-direction: column; gap: .125rem; width: 100%; padding: .5rem .875rem; border: 0; border-bottom: 1px solid var(--line);
      background: transparent; color: inherit; font: inherit; font-size: .75rem; text-align: left; cursor: pointer;
    }
    .version[aria-selected='true'] { background: var(--active) }
    .version:hover:not([aria-selected='true']) { background: var(--hover) }
    .version:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .head { display: flex; gap: .375rem }
    .author { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .when, .rev { font-family: var(--mono); font-size: .625rem; color: var(--faint) }
    .actions { padding: .75rem .875rem }
    .restore {
      width: 100%; height: 1.75rem; border: 1px solid var(--line-2); border-radius: .375rem; background: var(--panel);
      color: var(--fg); font: inherit; font-size: .75rem; cursor: pointer;
    }
    .restore:disabled { border-color: var(--line); background: var(--sunk); color: var(--faint); cursor: not-allowed }
    .restore:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
  `,
})
export class NoteHistoryComponent {
  readonly versions = input.required<readonly NoteVersionSummary[]>();
  readonly restore = output<number>();

  protected readonly selectedRev = signal<number | null>(null);
  protected readonly hasRestored = linkedSignal({ source: this.versions, computation: () => false });
  protected readonly newestFirst = computed(() => [...this.versions()].sort((a, b) => b.rev - a.rev));
  protected readonly hasSelection = computed(() => this.selectedRev() !== null);

  protected ageOf(version: NoteVersionSummary): string {
    return ageLabel(version.createdAt);
  }

  protected restoreSelected(): void {
    const rev = this.selectedRev();
    if (rev === null || this.hasRestored()) return;
    this.hasRestored.set(true);
    this.restore.emit(rev);
  }
}
