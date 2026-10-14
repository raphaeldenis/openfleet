import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, Injector, input, signal, untracked, viewChild } from '@angular/core';
import type { WorktreeEntry } from '@openfleet/shared';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { copyFor } from '../core/error-copy';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { refusalSentence } from '../core/worktree-refusal';
import { ErrorLineComponent } from '../design/error-line.component';

type LoadState = { status: 'loading' } | { status: 'failed'; text: string } | { status: 'ready'; items: readonly WorktreeEntry[] };

interface Repository {
  readonly repoPath: string;
  readonly worktrees: readonly WorktreeEntry[];
}

const SHORT_HEAD_LENGTH = 7;

const folderNameOf = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

const pluralFilesIgnored = (count: number): string => `${count} ignored ${count === 1 ? 'file' : 'files'} deleted`;

/** The worktrees of one project's repositories: why each one stays or goes, and a confirmed removal that never forces. */
@Component({
  selector: 'of-project-worktrees',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <section class="card" aria-labelledby="worktrees-title">
      <div class="card-head">
        <h2 id="worktrees-title" class="card-title">Repositories &amp; worktrees</h2>
        @if (readyItems(); as items) {
          <span class="count">{{ items.length }}</span>
        }
      </div>

      @if (removalFailure(); as failure) {
        <div class="banner"><of-error-line role="alert">{{ failure }}</of-error-line></div>
      }
      @if (removalResult(); as result) {
        <p #resultLine class="banner result" role="status" aria-label="Removal result" tabindex="-1">{{ result }}</p>
      }

      @switch (load().status) {
        @case ('loading') {
          <p class="note" role="status" aria-label="Loading worktrees">Loading worktrees…</p>
        }
        @case ('failed') {
          <div class="note">
            <of-error-line role="alert">{{ failedText() }}</of-error-line>
            <button type="button" class="of-btn of-btn--secondary of-btn--compact" data-retry (click)="reload()">Retry</button>
          </div>
        }
        @default {
          @if (repositories().length === 0) {
            <p class="note" data-empty tabindex="-1">No worktrees yet. The worktrees of the repositories this project's sessions work in appear here.</p>
          }
          @for (repository of repositories(); track repository.repoPath) {
            <h3 class="repo" [attr.title]="repository.repoPath">{{ visible(repository.repoPath) }}</h3>
            <ul class="rows" [attr.aria-label]="'Worktrees of ' + repository.repoPath">
              @for (entry of repository.worktrees; track entry.path) {
                <li>
                  <div class="row">
                    <span class="glyph" aria-hidden="true">⑂</span>
                    <span class="identity">
                      <span class="branch">{{ branchLabelOf(entry) }}</span>
                      <span class="path">{{ visible(entry.path) }}</span>
                    </span>
                    <span class="state">{{ stateLabelOf(entry) }}</span>
                    <span class="usage">{{ usageLabelOf(entry) }}</span>
                    <button
                      type="button"
                      class="of-btn of-btn--secondary of-btn--compact"
                      [attr.data-remove]="entry.path"
                      [attr.aria-label]="'Remove worktree ' + nameOf(entry)"
                      [attr.aria-disabled]="entry.removable ? null : 'true'"
                      [attr.aria-describedby]="entry.removable ? null : refusalIdOf(entry)"
                      (click)="askToRemove(entry)"
                    >Remove</button>
                  </div>
                  @if (refusalOf(entry); as refusal) {
                    <p class="refusal" [id]="refusalIdOf(entry)">{{ refusal }}</p>
                  }
                  @if (confirming() === entry.path) {
                    <div class="confirm" role="group" [attr.aria-label]="'Confirm removing ' + nameOf(entry)" [attr.aria-busy]="isRemoving() || null" (keydown.escape)="cancelOnEscape($event)">
                      <span class="confirm-text">Removing {{ nameOf(entry) }} deletes its folder and every file git ignores there (node_modules, .env, build output). The branch and its commits are kept.</span>
                      <button #cancelButton type="button" class="of-btn of-btn--secondary of-btn--compact" (click)="cancelConfirmation()">Cancel</button>
                      <button type="button" class="of-btn of-btn--danger of-btn--compact" [attr.aria-disabled]="isRemoving() ? 'true' : null" (click)="remove(entry)">Remove worktree</button>
                    </div>
                  }
                </li>
              }
            </ul>
          }
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; }
    .card-title { margin: 0; font-size: .8125rem; font-weight: 600; }
    .count { font-size: .6875rem; color: var(--mut); }
    .note { margin: 0; padding: .75rem .875rem; display: flex; align-items: center; gap: .5rem; font-size: .75rem; color: var(--mut); border-top: 1px solid var(--line); }
    .banner { margin: 0; min-width: 0; padding: .5rem .875rem; font-size: .75rem; border-top: 1px solid var(--line); background: var(--sunk); overflow-wrap: anywhere; }
    .banner:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .repo { margin: 0; padding: .5rem .875rem; border-top: 1px solid var(--line); background: var(--sunk); font-family: var(--mono); font-size: .75rem; font-weight: 500; overflow-wrap: anywhere; }
    .rows { list-style: none; margin: 0; padding: 0; }
    .rows li { border-top: 1px solid var(--line); }
    .row { display: flex; align-items: center; gap: .625rem; padding: .4375rem .875rem .4375rem 1.5rem; font-size: .75rem; }
    .glyph { color: var(--mut); }
    .identity { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .125rem; }
    .branch { font-family: var(--mono); overflow-wrap: anywhere; }
    .path { font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow-wrap: anywhere; }
    .state, .usage { font-size: .6875rem; color: var(--mut); white-space: nowrap; }
    .refusal { margin: 0; padding: 0 .875rem .4375rem 2.75rem; font-size: .6875rem; color: var(--mut); }
    .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .5rem .875rem .5rem 1.5rem; background: color-mix(in oklch, var(--state-error) 8%, var(--panel)); font-size: .75rem; }
    .confirm-text { flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; }
  `,
})
export class ProjectWorktreesComponent {
  private readonly api = inject(FleetApiService);
  private readonly events = inject(FleetEventsService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly resultLine = viewChild<ElementRef<HTMLElement>>('resultLine');
  private loadSequence = 0;

  readonly projectId = input.required<string>();

  protected readonly load = signal<LoadState>({ status: 'loading' });
  protected readonly confirming = signal<string | undefined>(undefined);
  protected readonly isRemoving = signal(false);
  protected readonly removalFailure = signal('');
  protected readonly removalResult = signal('');

  protected readonly readyItems = computed(() => {
    const state = this.load();
    return state.status === 'ready' ? state.items : undefined;
  });
  protected readonly failedText = computed(() => {
    const state = this.load();
    return state.status === 'failed' ? state.text : '';
  });
  protected readonly repositories = computed((): readonly Repository[] => {
    const byRepository = new Map<string, WorktreeEntry[]>();
    for (const entry of this.readyItems() ?? []) byRepository.set(entry.repoPath, [...(byRepository.get(entry.repoPath) ?? []), entry]);
    return [...byRepository].map(([repoPath, worktrees]) => ({ repoPath, worktrees }));
  });

  constructor() {
    effect(() => {
      const projectId = this.projectId();
      untracked(() => {
        this.resetForNewProject();
        void this.loadWorktrees({ projectId, isQuiet: false });
      });
    });
  }

  protected reload(): void {
    void this.loadWorktrees({ projectId: this.projectId(), isQuiet: false, restoresFocus: true });
  }

  protected visible(text: string): string {
    return showInvisibleControlsAsEscapes(text);
  }

  protected nameOf(entry: WorktreeEntry): string {
    const label = this.branchLabelOf(entry);
    const isDetached = entry.branch === null;
    const sharesLabelWithAnotherWorktree = (this.readyItems() ?? []).some((other) => other !== entry && other.branch === null && this.branchLabelOf(other) === label);
    return isDetached && sharesLabelWithAnotherWorktree ? `${label} (${showInvisibleControlsAsEscapes(folderNameOf(entry.path))})` : label;
  }

  protected branchLabelOf(entry: WorktreeEntry): string {
    if (entry.branch !== null) return showInvisibleControlsAsEscapes(entry.branch);
    return `detached · ${entry.head.slice(0, SHORT_HEAD_LENGTH)}`;
  }

  protected stateLabelOf({ isPrunable, isDirty }: WorktreeEntry): string {
    if (isPrunable) return 'Missing';
    return isDirty ? 'Modified' : 'Clean';
  }

  protected usageLabelOf(entry: WorktreeEntry): string {
    if (!entry.isInUse) return 'No session';
    const session = this.events.sessions().find((candidate) => candidate.id === entry.inUseBySessionId);
    return `In use by ${session ? showInvisibleControlsAsEscapes(session.name) : 'a session'}`;
  }

  protected refusalOf(entry: WorktreeEntry): string | undefined {
    return entry.notRemovableReason ? refusalSentence(entry.notRemovableReason) : undefined;
  }

  protected refusalIdOf(entry: WorktreeEntry): string {
    return `worktree-refusal-${entry.path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  protected askToRemove(entry: WorktreeEntry): void {
    if (!entry.removable || this.isRemoving()) return;
    this.removalFailure.set('');
    this.removalResult.set('');
    this.confirming.set(entry.path);
    afterNextRender(() => this.cancelButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelOnEscape(event: Event): void {
    event.stopPropagation();
    this.cancelConfirmation();
  }

  protected cancelConfirmation(): void {
    if (this.isRemoving()) return;
    const cancelledPath = this.confirming();
    this.confirming.set(undefined);
    afterNextRender(() => this.removeButtonOf(cancelledPath)?.focus(), { injector: this.injector });
  }

  protected async remove(entry: WorktreeEntry): Promise<void> {
    if (this.isRemoving()) return;
    const projectId = this.projectId();
    this.isRemoving.set(true);
    try {
      const removed = await this.api.removeWorktree(projectId, entry.path);
      if (this.projectId() !== projectId) return;
      const resultText = this.resultTextOf(entry, removed.ignoredFileCount);
      this.dropFromList(entry.path);
      this.confirming.set(undefined);
      this.removalResult.set(resultText);
      afterNextRender(() => this.resultLine()?.nativeElement.focus(), { injector: this.injector });
    } catch (error) {
      if (this.projectId() !== projectId) return;
      this.confirming.set(undefined);
      this.removalFailure.set(copyFor(error, { action: 'remove_worktree' }).text);
      afterNextRender(() => this.removeButtonOf(entry.path)?.focus(), { injector: this.injector });
      const daemonAnswered = error instanceof ApiError;
      if (daemonAnswered) void this.loadWorktrees({ projectId, isQuiet: true });
    } finally {
      this.isRemoving.set(false);
    }
  }

  private resultTextOf(entry: WorktreeEntry, ignoredFileCount: number | undefined): string {
    const deleted = ignoredFileCount ? ` — ${pluralFilesIgnored(ignoredFileCount)}` : '';
    return `Removed ${this.nameOf(entry)}${deleted}. The branch is kept.`;
  }

  private dropFromList(removedPath: string): void {
    this.load.update((state) => (state.status === 'ready' ? { status: 'ready', items: state.items.filter((entry) => entry.path !== removedPath) } : state));
  }

  private resetForNewProject(): void {
    this.confirming.set(undefined);
    this.isRemoving.set(false);
    this.removalFailure.set('');
    this.removalResult.set('');
  }

  private removeButtonOf(path: string | undefined): HTMLElement | undefined {
    const buttons = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-remove]');
    return [...buttons].find((button) => button.dataset['remove'] === path);
  }

  /** Only the answer of the latest request for the project on screen is kept; a quiet reload keeps the list while it runs. */
  private async loadWorktrees({ projectId, isQuiet, restoresFocus = false }: { projectId: string; isQuiet: boolean; restoresFocus?: boolean }): Promise<void> {
    const sequence = ++this.loadSequence;
    if (!isQuiet) this.load.set({ status: 'loading' });
    try {
      const list = await this.api.listWorktrees(projectId);
      if (sequence === this.loadSequence) this.load.set({ status: 'ready', items: list.items });
    } catch (error) {
      const isStillWanted = sequence === this.loadSequence && !isQuiet;
      if (isStillWanted) this.load.set({ status: 'failed', text: copyFor(error, { action: 'load_worktrees' }).text });
    }
    const isLatestAnswer = sequence === this.loadSequence;
    if (restoresFocus && isLatestAnswer) afterNextRender(() => this.firstLandingPoint()?.focus(), { injector: this.injector });
  }

  private firstLandingPoint(): HTMLElement | undefined {
    return this.host.nativeElement.querySelector<HTMLElement>('[data-remove], [data-retry], [data-empty]') ?? undefined;
  }
}
