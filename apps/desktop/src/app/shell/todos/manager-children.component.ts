import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { StateChipComponent } from '../../design/state-chip.component';
import { showInvisibleControlsAsEscapes } from '../../inbox/bidi-escapes';
import type { ChildProgress, ChildrenLoad } from './session-todos-source';
import { TodoProgressComponent } from './todo-progress.component';

const MAX_CHILD_ROWS = 20;
const CLOSED_STATE = 'closed';

interface ChildRow {
  readonly child: ChildProgress;
  readonly displayName: string;
  readonly link: readonly string[];
  readonly progressText: string;
  readonly isClosedWithUnfinishedWork: boolean;
}

function rowOf(child: ChildProgress): ChildRow {
  const { counts } = child;
  const isClosedWithUnfinishedWork = child.state === CLOSED_STATE && counts !== null && counts.completed < counts.total;
  return {
    child,
    displayName: showInvisibleControlsAsEscapes(child.name),
    link: [child.isManager ? '/manager' : '/session', child.id],
    progressText: counts ? `${counts.completed}/${counts.total} done` : 'no todos',
    isClosedWithUnfinishedWork,
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/** The progress of a manager's direct children: one line per child, each leading to that child's own session. */
@Component({
  selector: 'of-manager-children',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, StateChipComponent, TodoProgressComponent],
  template: `
    @if (load(); as current) {
      @if (current.kind === 'unsupported') {
        <p class="note" data-testid="manager-children-unsupported">Children's progress isn't available — this daemon doesn't report todos.</p>
      } @else if (rows().length > 0) {
        <section class="block" data-testid="manager-children" aria-labelledby="manager-children-heading">
          <h3 class="heading" id="manager-children-heading" data-testid="manager-children-summary">{{ summary() }}</h3>
          <ul class="rows" role="list">
            @for (row of shownRows(); track row.child.id) {
              <li class="row" data-testid="manager-child">
                <span class="emoji" aria-hidden="true">{{ row.child.emoji }}</span>
                <a class="name" data-testid="manager-child-link" [routerLink]="row.link" routerLinkActive ariaCurrentWhenActive="page" [title]="row.displayName">{{ row.displayName }}</a>
                <of-state-chip [state]="row.child.state" />
                <span class="progress-text" data-testid="manager-child-progress-text">{{ row.progressText }}</span>
                @if (row.isClosedWithUnfinishedWork) {
                  <span class="unfinished" data-testid="manager-child-unfinished">unfinished</span>
                }
                @if (row.child.counts; as counts) {
                  <of-todo-progress class="bar" [counts]="counts" />
                }
              </li>
            }
          </ul>
          @if (notShownText(); as notShown) {
            <p class="more" data-testid="manager-children-more">{{ notShown }}</p>
          }
        </section>
      }
    }
  `,
  styles: `
    :host { display: block; flex: none; max-height: 45%; overflow-y: auto; }
    .block { display: flex; flex-direction: column; gap: .375rem; color: var(--fg); font-size: .8125rem; }
    .heading { margin: 0; font-size: .8125rem; font-weight: 600; }
    .note, .more { margin: 0; color: var(--mut); font-size: .8125rem; }
    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
    .row { display: flex; align-items: center; flex-wrap: wrap; gap: .375rem; padding: .375rem .5rem; border-radius: .375rem; background: var(--panel); border: 1px solid var(--line); }
    .name { flex: 1 1 6rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-weight: 600; }
    .name:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .progress-text { color: var(--mut); font-size: .75rem; }
    .unfinished { color: var(--fg); font-size: .75rem; font-weight: 600; }
    .bar { flex-basis: 100%; }
  `,
})
export class ManagerChildrenComponent {
  readonly load = input.required<ChildrenLoad>();

  private readonly children = computed(() => {
    const load = this.load();
    const children = load.kind === 'ready' ? load.children : [];
    return children.map((child) => (child.counts && child.counts.total > 0 ? child : { ...child, counts: null }));
  });
  protected readonly rows = computed(() => this.children().map(rowOf));
  protected readonly shownRows = computed(() => this.rows().slice(0, MAX_CHILD_ROWS));
  protected readonly summary = computed(() => {
    const withList = this.children().flatMap((child) => (child.counts ? [child.counts] : []));
    if (withList.length === 0) return 'Children · no todos yet';
    const done = withList.reduce((sum, counts) => sum + counts.completed, 0);
    const total = withList.reduce((sum, counts) => sum + counts.total, 0);
    return `Children · ${done} of ${total} done across ${withList.length} ${plural(withList.length, 'child', 'children')}`;
  });
  protected readonly notShownText = computed(() => {
    const notShown = this.rows().length - MAX_CHILD_ROWS;
    return notShown > 0 ? `${notShown} more ${plural(notShown, 'child', 'children')} not shown` : '';
  });
}
