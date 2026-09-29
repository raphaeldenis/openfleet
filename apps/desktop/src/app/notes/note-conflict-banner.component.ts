import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

export type ConflictResolution = 'mine' | 'theirs' | 'merge' | 'restore';
export interface ConflictingVersion { author: string; at: string; body: string }

const DISK_AUTHOR = 'disk';

@Component({
  selector: 'of-note-conflict-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar" role="alert">
      <span class="label">! Edit conflict</span>
      <span class="message" data-testid="note-conflict-message">{{ message() }}</span>
      <button type="button" class="choice" data-testid="note-conflict-keep-mine" [disabled]="isResolved()" (click)="choose('mine')">Keep mine</button>
      <button type="button" class="choice" data-testid="note-conflict-take-theirs" [disabled]="isResolved()" (click)="choose('theirs')">{{ takeTheirsLabel() }}</button>
      <button type="button" class="choice choice--primary" data-testid="note-conflict-merge" [disabled]="isResolved()" (click)="choose('merge')">Merge both</button>
      @if (restoreRev(); as rev) {
        <button type="button" class="choice" data-testid="note-conflict-restore" [disabled]="isResolved()" (click)="choose('restore')">Restore rev {{ rev }} anyway</button>
      }
    </div>
    <div class="versions">
      <div class="version version--ours" data-testid="note-conflict-ours">
        <div class="version-label">Yours</div>{{ ours() }}
      </div>
      <div class="version version--theirs" data-testid="note-conflict-theirs">
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
    .label { color: var(--state-waiting-permission); font-weight: 600 }
    .message { flex: 1 }
    .choice {
      height: 1.5rem; padding: 0 .625rem; border: 1px solid var(--line-2); border-radius: .375rem;
      background: var(--panel); color: var(--fg); cursor: pointer; font: inherit; font-size: .75rem;
    }
    .choice--primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent) }
    .choice:disabled { border-color: var(--line); background: var(--sunk); color: var(--faint); cursor: not-allowed }
    .choice:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .versions { display: flex; flex-direction: column; gap: .5rem; padding: .75rem 1.25rem; max-height: 14rem; overflow: auto; font-size: .8125rem }
    .version { padding: .625rem .75rem; border-left: 3px solid; border-radius: 0 .375rem .375rem 0; white-space: pre-wrap }
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

  protected readonly isResolved = signal(false);
  private readonly isDiskConflict = computed(() => this.theirs().author === DISK_AUTHOR);
  protected readonly message = computed(() =>
    this.isDiskConflict()
      ? 'This note changed on disk since you opened it. Your version is kept below; nothing is lost.'
      : `${this.theirs().author} saved while you were typing. Your version is kept below; nothing is lost.`,
  );
  protected readonly takeTheirsLabel = computed(() => (this.isDiskConflict() ? 'Keep disk' : `Take ${this.theirs().author}’s`));

  protected choose(resolution: ConflictResolution): void {
    if (this.isResolved()) return;
    this.isResolved.set(true);
    this.resolve.emit(resolution);
  }
}
