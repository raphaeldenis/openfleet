import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MANAGER_ROLE, type ManagerView, type Session } from '@openfleet/shared';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { FleetEventsService } from '../core/fleet-events.service';
import { StateChipComponent } from '../design/state-chip.component';
import { countdownLabel, countdownSecondsUntil } from '../managers/manager-countdown';

interface ManagerRow {
  readonly session: Session;
  readonly view: ManagerView | undefined;
  readonly countdown: string;
}

const EMPTY_MESSAGE = 'No managers yet';

@Component({
  selector: 'of-manager-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent],
  template: `
    <section class="managers" data-testid="manager-group">
      <h3 class="group-title">Managers</h3>
      @if (rows().length === 0) {
        <p class="empty">${EMPTY_MESSAGE}</p>
      } @else {
        <ul>
          @for (row of rows(); track row.session.id) {
            <li>
              <button
                type="button"
                class="row"
                [class.closed]="row.session.state === 'closed'"
                [attr.data-testid]="'manager-row-' + row.session.id"
                [attr.aria-label]="visibleNameOf(row.session) + ' — ' + row.session.state"
                (click)="open(row.session)"
              >
                <span class="name" [attr.title]="visibleNameOf(row.session)">{{ row.session.emoji }} {{ visibleNameOf(row.session) }}</span>
                <span class="meta">
                  <of-state-chip [state]="row.session.state" />
                  @if (row.view; as view) {
                    <span [attr.data-testid]="'manager-row-' + row.session.id + '-children'" title="Children">{{ view.childrenCount }}/{{ view.childrenCap }}</span>
                    <span [attr.data-testid]="'manager-row-' + row.session.id + '-countdown'" title="Next pulse">{{ row.countdown }}</span>
                  }
                </span>
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .managers { border-bottom: 1px solid var(--line); padding-bottom: .25rem }
    .group-title { margin: 0; display: flex; align-items: center; height: 1.875rem; padding: 0 .75rem; font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--mut) }
    ul { list-style: none; padding: 0; margin: 0 }
    .empty { margin: 0; padding: .25rem .75rem .5rem; font-size: .75rem; color: var(--mut) }
    .row {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .125rem .5rem;
      padding: .4rem .6rem; cursor: pointer; width: 100%; border: none; background: none;
      font: inherit; color: var(--fg); text-align: left; min-width: 0;
    }
    .row.closed { opacity: .5 }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .row .name { flex: 1 1 6rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .row .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .125rem .375rem; font-size: .6875rem; color: var(--mut); font-family: var(--mono) }
  `,
})
export class ManagerGroupComponent {
  private readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected readonly rows = computed((): ManagerRow[] => {
    const views = this.events.managers();
    const now = this.now();
    return this.events
      .sessions()
      .filter((session) => session.role === MANAGER_ROLE)
      .map((session) => {
        const view = views.find((candidate) => candidate.sessionId === session.id);
        const isClosed = session.state === 'closed';
        const countdown = isClosed || !view ? 'closed' : countdownLabel(countdownSecondsUntil(view.nextPulseAt, now));
        return { session, view, countdown };
      });
  });

  protected visibleNameOf(session: Session): string {
    return showInvisibleControlsAsEscapes(session.name);
  }

  protected open(session: Session): void {
    void this.router.navigate(['/manager', session.id]);
  }
}
