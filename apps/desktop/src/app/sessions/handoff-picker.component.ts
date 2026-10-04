import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, Injector, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import type { HandoffSummary, Project } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';
import { moveFocusWithinListbox } from '../design/listbox-keyboard';

interface HandoffListState {
  projectId: string | undefined;
  phase: 'loading' | 'ready' | 'error';
  items: HandoffSummary[];
}

@Component({
  selector: 'of-handoff-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <div class="picker" (keydown.escape)="closeList($event)">
      <span class="of-label">Start from a handoff · optional</span>
      <button #trigger type="button" role="combobox" class="of-btn of-btn--secondary" aria-label="Start from a handoff" aria-haspopup="listbox" [attr.aria-expanded]="isExpanded()" [attr.aria-controls]="listId" [attr.aria-describedby]="isAvailable() ? null : reasonId" [disabled]="!isAvailable() || isLocked()" (click)="toggleList()" (keydown.arrowdown)="openWithKeyboard($event)">
        Choose a handoff…
      </button>
      @if (!isAvailable()) {
        <p class="caption" [id]="reasonId">Choose a project with a docs folder to start from a handoff.</p>
      }
      @if (file(); as selectedFile) {
        <div class="chip-row">
          <span class="file" title="Added to the first prompt as read-only context">@file handoffs/{{ selectedFile }}</span>
          <button type="button" class="of-btn of-btn--compact of-btn--secondary" [attr.aria-label]="'Remove handoff ' + selectedFile" [disabled]="isLocked()" (click)="remove()">Remove</button>
        </div>
      }
      @if (isExpanded()) {
        <div class="panel">
          <p class="caption" role="status" aria-live="polite">{{ phase() === 'loading' ? 'Loading handoffs…' : '' }}</p>
          @if (phase() === 'error') {
            <div class="error-row" role="alert"><of-error-line>Handoffs could not be loaded — check your connection, then try again.</of-error-line><button type="button" class="of-btn of-btn--compact of-btn--primary" (click)="retry()">Try again</button></div>
          }
          @if (items().length > searchThreshold) {
            <input type="search" class="of-input" aria-label="Search handoffs" placeholder="Search handoffs…" [value]="search()" (input)="updateSearch($event)" (keydown.arrowdown)="focusFirstOption($event)" />
          }
          <div #listbox [id]="listId" role="listbox" aria-label="Handoffs" [attr.aria-busy]="phase() === 'loading'" (keydown)="moveFocus($event)">
            @for (handoff of filteredItems(); track handoff.noteId) {
              <button type="button" class="handoff-option" role="option" tabindex="-1" [attr.aria-selected]="file() === handoff.file" [disabled]="isLocked()" (click)="choose(handoff.file)">
                <span class="file">{{ handoff.file }}</span><span>{{ handoff.title }}</span><span class="caption">{{ relativeDate(handoff.updatedAt) }}</span>
              </button>
            }
          </div>
          @if (phase() === 'ready' && items().length === 0) {
            <p class="caption">No handoffs yet — they appear here once a session writes one.</p>
          } @else if (phase() === 'ready' && filteredItems().length === 0) {
            <p class="caption">No matching handoffs.</p>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .picker { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; min-width: 0 }
    .caption { margin: 0; font-size: .6875rem; color: var(--mut) }
    .caption:empty { display: none }
    .chip-row, .error-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem }
    .file { font-family: var(--mono); overflow-wrap: anywhere }
    .chip-row { font-size: .75rem; color: var(--fg) }
    .panel { align-self: stretch; display: flex; flex-direction: column; gap: .5rem; padding: .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--sunk) }
    [role='listbox'] { max-height: 14rem; overflow-y: auto }
    .handoff-option { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; width: 100%; min-height: 1.75rem; padding: .375rem .5rem; border: 0; border-radius: .25rem; background: transparent; color: var(--fg); font: inherit; font-size: .75rem; text-align: left; cursor: pointer }
    .handoff-option:hover, .handoff-option[aria-selected='true'] { background: var(--panel) }
    .handoff-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
  `,
})
export class HandoffPickerComponent {
  readonly project = input<Project | undefined>();
  readonly file = input<string | undefined>();
  readonly isLocked = input(false);
  readonly fileChange = output<string | undefined>();
  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly listbox = viewChild<ElementRef<HTMLElement>>('listbox');
  protected readonly listId = 'new-session-handoff-list';
  protected readonly reasonId = 'new-session-handoff-reason';
  protected readonly searchThreshold = 8;
  protected readonly isAvailable = computed(() => Boolean(this.project()?.docsFolderPath));
  protected readonly isExpanded = linkedSignal(() => { this.project(); return false; });
  protected readonly search = linkedSignal(() => { this.project(); return ''; });
  private readonly listState = signal<HandoffListState>({ projectId: undefined, phase: 'ready', items: [] });
  protected readonly items = computed(() => this.listState().projectId === this.project()?.id ? this.listState().items : []);
  protected readonly phase = computed(() => this.listState().projectId === this.project()?.id ? this.listState().phase : 'loading');
  protected readonly filteredItems = computed(() => {
    const query = this.search().trim().toLocaleLowerCase();
    return this.items().filter((handoff) => `${handoff.file} ${handoff.title}`.toLocaleLowerCase().includes(query));
  });
  private requestVersion = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.requestVersion++);
    effect(() => {
      const project = this.project();
      if (project?.docsFolderPath) void this.load(project.id);
      else this.requestVersion++;
    });
  }

  protected toggleList(): void {
    if (this.isLocked() || !this.isAvailable()) return;
    this.isExpanded.update((expanded) => !expanded);
    if (this.isExpanded()) this.focusOptionsAfterRender();
  }

  protected openWithKeyboard(event: Event): void {
    event.preventDefault();
    if (this.isLocked() || !this.isAvailable()) return;
    this.isExpanded.set(true);
    this.focusOptionsAfterRender();
  }

  protected closeList(event?: Event): void {
    if (!this.isExpanded()) return;
    event?.preventDefault();
    event?.stopPropagation();
    this.isExpanded.set(false);
    this.trigger()?.nativeElement.focus();
  }

  protected choose(file: string): void {
    if (this.isLocked()) return;
    this.fileChange.emit(file);
    this.closeList();
  }

  protected remove(): void {
    if (this.isLocked()) return;
    this.fileChange.emit(undefined);
    this.trigger()?.nativeElement.focus();
  }

  protected updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected moveFocus(event: KeyboardEvent): void {
    const listbox = this.listbox()?.nativeElement;
    if (listbox) moveFocusWithinListbox(event, listbox);
  }

  protected focusFirstOption(event: Event): void {
    event.preventDefault();
    this.listbox()?.nativeElement.querySelector<HTMLElement>('[role="option"]')?.focus();
  }

  protected relativeDate(updatedAt: string): string {
    const elapsedDays = Math.round((Date.parse(updatedAt) - Date.now()) / 86_400_000);
    return Number.isFinite(elapsedDays) ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(elapsedDays, 'day') : '';
  }

  protected retry(): void {
    const projectId = this.project()?.id;
    if (projectId && !this.isLocked()) void this.load(projectId);
  }

  private async load(projectId: string): Promise<void> {
    const version = ++this.requestVersion;
    this.listState.set({ projectId, phase: 'loading', items: [] });
    try {
      const page = await this.api.listHandoffs(projectId);
      if (version !== this.requestVersion) return;
      this.listState.set({ projectId, phase: 'ready', items: page.items });
      if (this.isExpanded()) this.focusOptionsAfterRender();
    } catch {
      if (version === this.requestVersion) this.listState.set({ projectId, phase: 'error', items: [] });
    }
  }

  private focusOptionsAfterRender(): void {
    afterNextRender(() => {
      if (!this.isExpanded()) return;
      this.listbox()?.nativeElement.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus();
    }, { injector: this.injector });
  }
}
