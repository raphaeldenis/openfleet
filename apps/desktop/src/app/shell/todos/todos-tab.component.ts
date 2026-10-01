import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input } from '@angular/core';
import { showInvisibleControlsAsEscapes } from '../../inbox/bidi-escapes';
import { SESSION_TODOS_SOURCE, type TodosLoad } from './session-todos-source';
import { TODO_STATUS_PRESENTATION, UNKNOWN_STATUS_PRESENTATION } from './todo-status';
import { MAX_TODO_ITEMS, type SessionTodos, type TodoItem } from './todos.adapter';

const UNNAMED_SUFFIX = 'name not seen yet';
const UNVERIFIED_HINT = 'from history, not confirmed yet';

interface TodoRow {
  readonly id: string;
  readonly status: TodoItem['status'];
  readonly glyph: string;
  readonly statusLabel: string;
  readonly text: string;
  readonly unnamed: boolean;
  readonly unverified: boolean;
}

function clockTimeOf(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

@Component({
  selector: 'of-todos-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tab" data-testid="todos-tab">
      @if (!sessionId()) {
        <p class="message" data-testid="todos-no-session">Select a session to see its todos.</p>
      } @else {
        @switch (load().kind) {
          @case ('loading') {
            <p class="message" role="status" data-testid="todos-loading">Loading todos…</p>
          }
          @case ('error') {
            <div class="message" role="alert" data-testid="todos-error">
              <p>{{ errorText() }}</p>
              @if (isRetryable()) {
                <button type="button" class="of-btn" data-testid="todos-retry" (click)="retry()">Try again</button>
              }
            </div>
          }
          @case ('unsupported') {
            <p class="message" data-testid="todos-unsupported">This daemon doesn't report todos — update the daemon.</p>
          }
          @default {
            @if (list(); as todos) {
              @if (sessionClosed()) {
                <p class="note" role="status" data-testid="todos-closed-note">{{ closedNote() }}</p>
              }
              @if (staleNote(); as note) {
                <p class="note" role="status" data-testid="todos-stale-note">{{ note }}</p>
              }
              @if (todos.incomplete) {
                <p class="note" role="status" data-testid="todos-incomplete-note">Some tasks aren't named yet — the list completes when the agent lists its tasks.</p>
              }
              <section class="progress" data-testid="todos-progress">
                @for (shownSession of [sessionId()]; track shownSession) {
                  <p class="progress-text" aria-live="polite">{{ progressText() }}</p>
                }
                <div class="track" role="progressbar" aria-label="Todo progress" aria-valuemin="0"
                     [attr.aria-valuemax]="todos.counts.total" [attr.aria-valuenow]="todos.counts.completed" [attr.aria-valuetext]="progressText()">
                  <div class="fill" [style.width.%]="progressPercent()"></div>
                </div>
                @if (progressDetail(); as detail) {
                  <p class="detail" data-testid="todos-progress-detail">{{ detail }}</p>
                }
              </section>
              <div class="list-region" role="region" aria-label="Todo list" tabindex="0" data-testid="todos-list">
                <ul class="rows" role="list">
                  @for (row of rows(); track row.id) {
                    <li class="row" data-testid="todo-item" [attr.data-status]="row.status">
                      <span class="glyph" aria-hidden="true">{{ row.glyph }}</span>
                      <span class="status" data-testid="todo-item-status">{{ row.statusLabel }}</span>
                      <span class="text" data-testid="todo-item-text">{{ row.text }}</span>
                      @if (row.unnamed) {
                        <span class="unnamed" data-testid="todo-item-unnamed">— {{ unnamedSuffix }}</span>
                      }
                      @if (row.unverified) {
                        <span class="unnamed" data-testid="todo-item-unverified">{{ unverifiedHint }}</span>
                      }
                    </li>
                  }
                </ul>
                @if (notShownText(); as notShown) {
                  <p class="detail" data-testid="todos-omitted">{{ notShown }}</p>
                }
              </div>
            } @else {
              <p class="message" data-testid="todos-empty">{{ emptyText() }}</p>
            }
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .tab { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: .5rem; padding: .625rem; color: var(--fg); font-size: .8125rem; }
    .message, .note, .detail, .progress-text { margin: 0; }
    .message { display: flex; flex-direction: column; align-items: flex-start; gap: .5rem; color: var(--mut); }
    .note { padding: .375rem .5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg); }
    .progress { display: flex; flex-direction: column; gap: .25rem; flex: none; }
    .progress-text { font-weight: 600; }
    .track { height: .375rem; border-radius: .1875rem; background: var(--sunk); border: 1px solid var(--line); overflow: hidden; }
    .fill { height: 100%; min-width: .25rem; background: var(--state-waiting-permission); }
    .detail { color: var(--mut); }
    .list-region { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: .5rem; }
    .list-region:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
    .row { display: flex; align-items: baseline; flex-wrap: wrap; gap: .375rem; padding: .375rem .5rem; border-radius: .375rem; background: var(--panel); border: 1px solid var(--line); }
    .row[data-status='completed'] { color: var(--mut); }
    .glyph { flex: none; width: 1rem; text-align: center; font-family: var(--mono); }
    .status { flex: none; min-width: 5rem; font-size: .75rem; font-weight: 600; }
    .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .unnamed { flex-basis: 100%; padding-left: 1.375rem; color: var(--mut); font-size: .75rem; }
  `,
})
export class TodosTabComponent {
  readonly sessionId = input<string | undefined>(undefined);
  readonly sessionClosed = input(false);
  readonly connected = input(true);

  private readonly source = inject(SESSION_TODOS_SOURCE);
  protected readonly unnamedSuffix = UNNAMED_SUFFIX;
  protected readonly unverifiedHint = UNVERIFIED_HINT;

  constructor() {
    effect(() => this.source.watch(this.sessionId()));
    inject(DestroyRef).onDestroy(() => this.source.watch(undefined));
  }

  protected readonly load = computed<TodosLoad>(() => {
    const id = this.sessionId();
    return id ? this.source.loadOf(id)() : { kind: 'loading' };
  });
  protected readonly list = computed<SessionTodos | undefined>(() => {
    const load = this.load();
    if (load.kind !== 'ready' || load.todos === null) return undefined;
    const hasTasks = load.todos.counts.total > 0;
    return hasTasks ? load.todos : undefined;
  });
  protected readonly errorText = computed(() => {
    const load = this.load();
    return load.kind === 'error' ? load.text : '';
  });
  protected readonly isRetryable = computed(() => {
    const load = this.load();
    return load.kind === 'error' && load.retryable;
  });
  protected readonly emptyText = computed(() => {
    const load = this.load();
    const isClosedWithoutKeptList = this.sessionClosed() && load.kind === 'ready' && load.todos === null;
    return isClosedWithoutKeptList ? "This list isn't kept once the daemon restarts." : "No todos yet — this session hasn't made a list.";
  });
  protected readonly closedNote = computed(() => {
    const updatedAt = this.list()?.updatedAt;
    return updatedAt ? `Session closed — list as of ${clockTimeOf(updatedAt)}.` : 'Session closed — last known list.';
  });
  protected readonly staleNote = computed(() => {
    if (this.list()?.stale) return "Last known list — the session's transcript can't be read right now.";
    return this.connected() ? undefined : 'Last known list — reconnecting to the daemon.';
  });
  protected readonly progressText = computed(() => {
    const counts = this.list()?.counts;
    return counts ? `${counts.completed} of ${counts.total} completed` : '';
  });
  protected readonly progressPercent = computed(() => {
    const counts = this.list()?.counts;
    return counts && counts.total > 0 ? (counts.completed / counts.total) * 100 : 0;
  });
  protected readonly progressDetail = computed(() => {
    const counts = this.list()?.counts;
    if (!counts) return '';
    const parts = [
      counts.inProgress > 0 ? `${counts.inProgress} in progress` : '',
      counts.pending > 0 ? `${counts.pending} pending` : '',
    ];
    return parts.filter((part) => part !== '').join(' · ');
  });
  protected readonly rows = computed<TodoRow[]>(() => {
    const items = this.list()?.items ?? [];
    return items.slice(0, MAX_TODO_ITEMS).map(rowOf);
  });
  protected readonly notShownText = computed(() => {
    const todos = this.list();
    if (!todos) return '';
    const beyondRenderCap = Math.max(0, todos.items.length - MAX_TODO_ITEMS);
    const notShown = todos.omitted + beyondRenderCap;
    if (notShown === 0) return '';
    return `${notShown} more ${notShown === 1 ? 'todo' : 'todos'} not shown`;
  });

  retry(): void {
    const id = this.sessionId();
    if (id) this.source.retry(id);
  }
}

function rowOf(item: TodoItem): TodoRow {
  const { glyph, label } = TODO_STATUS_PRESENTATION[item.status] ?? UNKNOWN_STATUS_PRESENTATION;
  const isActiveForm = item.status === 'in_progress' && item.activeForm !== undefined;
  const text = showInvisibleControlsAsEscapes(isActiveForm ? (item.activeForm as string) : item.content);
  return { id: item.id, status: item.status, glyph, statusLabel: label, text, unnamed: item.unnamed === true, unverified: item.unverified === true };
}
