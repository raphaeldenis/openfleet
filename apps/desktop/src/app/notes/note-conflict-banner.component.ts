import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, input, output, viewChild } from '@angular/core';

export type ConflictResolution = 'mine' | 'theirs' | 'merge' | 'restore';
export interface ConflictingVersion { author: string; at: string; body: string }

const DISK_AUTHOR = 'disk';
const CURRENT_USER_AUTHOR = 'You';

@Component({
  selector: 'of-note-conflict-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #bar class="bar" role="alert" tabindex="-1" data-testid="note-conflict-bar">
      <span class="label" data-testid="note-conflict-label"><span class="glyph" aria-hidden="true">!</span> Edit conflict</span>
      <span class="message" data-testid="note-conflict-message">{{ message() }}</span>
      @if (restoreRev() !== null) {
        <button type="button" class="of-btn of-btn--primary of-btn--compact" data-testid="note-conflict-keep-current" (click)="resolve.emit('theirs')">Keep current</button>
        <button type="button" class="of-btn of-btn--secondary of-btn--compact" data-testid="note-conflict-restore" (click)="resolve.emit('restore')">Restore rev {{ restoreRev() }} anyway</button>
      } @else {
        <button type="button" class="of-btn of-btn--secondary of-btn--compact" data-testid="note-conflict-keep-mine" (click)="resolve.emit('mine')">Keep mine</button>
        <button type="button" class="of-btn of-btn--secondary of-btn--compact" data-testid="note-conflict-take-theirs" (click)="resolve.emit('theirs')">{{ takeTheirsLabel() }}</button>
        <button type="button" class="of-btn of-btn--primary of-btn--compact" data-testid="note-conflict-merge" (click)="resolve.emit('merge')">Merge both</button>
      }
    </div>
    <div class="versions">
      <div class="version version--ours" role="region" aria-label="Your version" tabindex="0" data-testid="note-conflict-ours">
        <div class="version-label">{{ restoreRev() === null ? 'Yours' : 'You had open' }}</div>{{ ours() }}
      </div>
      <div class="version version--theirs" role="region" [attr.aria-label]="'Version by ' + theirs().author" tabindex="0" data-testid="note-conflict-theirs">
        <div class="version-label">{{ theirs().author }} · {{ theirs().at }}</div>{{ theirs().body }}
      </div>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: none; border-bottom: 1px solid var(--line) }
    .bar {
      display: flex; align-items: center; gap: .75rem; padding: .5rem 1.25rem; font-size: .75rem;
      background: color-mix(in oklch, var(--state-waiting-permission) 12%, var(--panel));
      border-bottom: 1px solid var(--line);
    }
    .label { color: var(--fg); font-weight: 600 }
    .glyph { color: var(--state-waiting-permission) }
    .message { flex: 1; min-width: 0; overflow-wrap: anywhere }
    .bar:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .versions { display: flex; flex-direction: column; gap: .5rem; padding: .75rem 1.25rem; font-size: .8125rem }
    .version {
      max-height: 9rem; overflow: auto; overflow-wrap: anywhere; padding: .625rem .75rem;
      border-left: 3px solid; border-radius: 0 .375rem .375rem 0; white-space: pre-wrap;
    }
    .version:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .version--ours { border-color: var(--state-idle); background: color-mix(in oklch, var(--state-idle) 8%, transparent) }
    .version--theirs { border-color: var(--state-generating); background: color-mix(in oklch, var(--state-generating) 8%, transparent) }
    .version-label { font-size: .6875rem; color: var(--mut); margin-bottom: .25rem }
  `,
})
export class NoteConflictBannerComponent {
  readonly ours = input.required<string>();
  readonly theirs = input.required<ConflictingVersion>();
  readonly restoreRev = input<number | null>(null);
  readonly resolve = output<ConflictResolution>();

  constructor() {
    afterNextRender(() => this.bar().nativeElement.focus());
  }

  private readonly bar = viewChild.required<ElementRef<HTMLElement>>('bar');
  private readonly isDiskConflict = computed(() => this.theirs().author === DISK_AUTHOR);
  private readonly isOwnSave = computed(() => this.theirs().author === CURRENT_USER_AUTHOR);
  protected readonly message = computed(() => {
    const { author } = this.theirs();
    const rev = this.restoreRev();
    const saver = this.isOwnSave() ? 'You saved from another window' : `${author} saved`;
    const saverPossessive = this.isOwnSave() ? 'your own' : `${author}’s`;
    if (rev !== null) {
      return `${saver} this note while you were restoring rev ${rev}. Keep current cancels the restore and writes nothing; Restore rev ${rev} anyway replaces ${saverPossessive} save with rev ${rev}.`;
    }
    return this.isDiskConflict()
      ? 'This note changed on disk since you opened it. Your version is kept below; nothing is lost.'
      : `${saver} while you were typing. Your version is kept below; nothing is lost.`;
  });
  protected readonly takeTheirsLabel = computed(() => {
    if (this.isDiskConflict()) return 'Keep disk';
    return this.isOwnSave() ? 'Take your other save' : `Take ${this.theirs().author}’s`;
  });
}
