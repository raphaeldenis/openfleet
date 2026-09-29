import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { absoluteDateLabel, ageLabel } from './note-age';
import type { NoteVersionSummary } from '@openfleet/shared';

@Component({
  selector: 'of-note-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close.emit()' },
  template: `
    <div class="title">History</div>
    @if (error()) {
      <div class="error" role="alert" data-testid="note-history-error">
        <span [attr.title]="errorDetail() || null">Couldn’t load the history: {{ error() }}</span>
        <button type="button" class="of-btn of-btn--secondary" data-testid="note-history-retry" (click)="retry.emit()">Retry</button>
      </div>
    }
    <ul class="versions">
      @for (version of newestFirst(); track version.id) {
        <li>
          <button
            type="button"
            class="version"
            [attr.data-testid]="'note-history-version-' + version.rev"
            [attr.aria-pressed]="version.rev === selectedRev()"
            (click)="selectedRev.set(version.rev)"
          >
            <span class="head">
              <span class="author">{{ version.author }}</span>
              <time class="when" [attr.datetime]="version.createdAt" [attr.title]="absoluteDateOf(version)" [attr.data-testid]="'note-history-when-' + version.rev">{{ ageOf(version) }}</time>
            </span>
            <span class="rev">rev {{ version.rev }}</span>
          </button>
        </li>
      }
    </ul>
    <div class="actions">
      <button type="button" class="restore" data-testid="note-history-restore" [disabled]="!canRestoreSelection()" (click)="restoreSelected()">
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
    .version[aria-pressed='true'] { background: var(--active) }
    .version:hover:not([aria-pressed='true']) { background: var(--hover) }
    .version:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .head { display: flex; gap: .375rem }
    .author { font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .when, .rev { font-family: var(--mono); font-size: .625rem; color: var(--faint) }
    .error { display: flex; flex-direction: column; gap: .5rem; padding: .625rem .875rem; font-size: .75rem; color: var(--mut) }
    .error { color: var(--state-error) }
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
  readonly currentRev = input<number | null>(null);
  readonly isRestoreBlocked = input(false);
  readonly error = input('');
  readonly errorDetail = input('');
  readonly restore = output<number>();
  readonly retry = output<void>();
  readonly close = output<void>();

  protected readonly selectedRev = linkedSignal<number | null, number | null>({ source: this.currentRev, computation: () => null });
  protected readonly newestFirst = computed(() => [...this.versions()].sort((a, b) => b.rev - a.rev));
  protected readonly canRestoreSelection = computed(() => {
    const rev = this.selectedRev();
    const isSelectionRestorable = rev !== null && rev !== this.currentRev();
    return isSelectionRestorable && !this.isRestoreBlocked();
  });

  protected ageOf(version: NoteVersionSummary): string {
    return ageLabel(version.createdAt);
  }

  protected absoluteDateOf(version: NoteVersionSummary): string | null {
    return absoluteDateLabel(version.createdAt);
  }

  protected restoreSelected(): void {
    const rev = this.selectedRev();
    if (rev === null || !this.canRestoreSelection()) return;
    this.restore.emit(rev);
  }
}
