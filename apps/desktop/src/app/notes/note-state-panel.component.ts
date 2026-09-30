import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type NotePaneState = 'loading' | 'error' | 'empty';

const SKELETON_BAR_WIDTHS = ['40%', '90%', '85%', '60%', '95%', '70%'];

@Component({
  selector: 'of-note-state-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state()) {
      @case ('loading') {
        <div class="skeleton" data-testid="note-skeleton" role="status" aria-busy="true" aria-label="Loading note">
          @for (width of skeletonBarWidths; track $index) {
            <div class="bar" data-testid="note-skeleton-bar" [style.width]="width"></div>
          }
        </div>
      }
      @case ('error') {
        <div class="error" role="alert" data-testid="note-error">
          <span class="error-title" data-testid="note-error-title">✕ Couldn’t open “{{ title() }}”</span>
          <span class="error-reason" [attr.title]="reasonDetail() || null" data-testid="note-error-reason">{{ reason() }}</span>
          <div class="actions">
            @if (canOpenInFinder()) {
              <button type="button" class="of-btn of-btn--secondary" data-testid="note-error-open-in-finder" (click)="openInFinder.emit()">Open in Finder</button>
            }
            <button type="button" class="of-btn of-btn--secondary" data-testid="note-error-retry" (click)="retry.emit()">Retry</button>
          </div>
        </div>
      }
      @case ('empty') {
        <div class="empty">
          <span class="empty-headline" data-testid="note-empty-headline">Notes are shared memory for you and your agents</span>
          <span data-testid="note-empty-hint">Agents write notes with the notes tool and they appear here.</span>
          <button type="button" class="of-btn of-btn--primary create" data-testid="note-empty-create" (click)="create.emit()">New note</button>
        </div>
      }
    }
  `,
  styles: `
    :host { display: flex; flex: 1; min-height: 0; flex-direction: column }
    .skeleton { padding: 2rem 3rem; display: flex; flex-direction: column; gap: .75rem }
    .bar { height: .875rem; border-radius: .25rem; background: var(--sunk); animation: of-live 1.4s ease-in-out infinite }
    .error {
      margin: 2rem auto; width: 28rem; max-width: calc(100% - 2rem); display: flex; flex-direction: column; gap: .5rem;
      padding: 1.25rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel);
    }
    .error-title { color: var(--state-error); font-weight: 600 }
    .error-reason { color: var(--mut) }
    .actions { display: flex; gap: .5rem }
    .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; color: var(--mut); text-align: center; padding: 1rem }
    .empty-headline { color: var(--fg); font-weight: 500 }
    .create { margin-top: .5rem }
  `,
})
export class NoteStatePanelComponent {
  readonly state = input.required<NotePaneState>();
  readonly title = input('');
  readonly reason = input('');
  readonly reasonDetail = input('');
  readonly canOpenInFinder = input(true);
  readonly retry = output<void>();
  readonly openInFinder = output<void>();
  readonly create = output<void>();

  protected readonly skeletonBarWidths = SKELETON_BAR_WIDTHS;
}
