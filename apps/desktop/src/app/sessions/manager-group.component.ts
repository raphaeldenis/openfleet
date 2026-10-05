import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MANAGER_ROLE, type ManagerView, type Session } from '@openfleet/shared';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { FleetEventsService } from '../core/fleet-events.service';
import { WatchedSession } from '../core/watched-session';
import { StateChipComponent } from '../design/state-chip.component';
import { countdownLabel, countdownSecondsUntil } from '../managers/manager-countdown';

interface ManagerRow {
  readonly session: Session;
  readonly view: ManagerView | undefined;
  readonly countdown: string;
  readonly countdownTip: string;
}

const EMPTY_MESSAGE = 'No managers yet';
const NO_PULSE_LABEL = '—';

@Component({
  selector: 'of-manager-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent],
  template: `
    <section class="managers" data-testid="manager-group">
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
                [attr.aria-current]="row.session.id === watchedSessionId() ? 'true' : null"
                [attr.data-testid]="'manager-row-' + row.session.id"
                [attr.aria-label]="visibleNameOf(row.session) + ' — ' + row.session.state"
                (click)="open(row.session)"
              >
                <span class="tile" aria-hidden="true">{{ row.session.emoji }}</span>
                <span class="text">
                  <span class="name" [attr.title]="visibleNameOf(row.session)">{{ visibleNameOf(row.session) }}</span>
                  <span class="detail-line">
                    <of-state-chip [state]="row.session.state" />
                    @if (row.view; as view) {
                      <span class="pulse-meta">
                        <span [attr.data-testid]="'manager-row-' + row.session.id + '-children'" title="Children">{{ view.childrenCount }}/{{ view.childrenCap }}</span>
                        <span [attr.data-testid]="'manager-row-' + row.session.id + '-countdown'" [title]="row.countdownTip">◎ {{ row.countdown }}</span>
                      </span>
                    }
                  </span>
                </span>
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .managers { padding-bottom: .25rem }
    ul { list-style: none; padding: 0; margin: 0 }
    .empty { margin: 0; padding: .25rem .75rem .5rem; font-size: .75rem; color: var(--mut) }
    .row {
      display: flex; align-items: center; gap: .5rem;
      padding: .4rem .6rem; cursor: pointer; width: 100%; border: none; background: none;
      font: inherit; color: var(--fg); text-align: left; min-width: 0;
    }
    .tile { display: flex; flex: none; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border: 1px solid var(--line); border-radius: 50%; background: var(--sunk) }
    .text { display: flex; flex-direction: column; flex: 1; gap: .125rem; min-width: 0 }
    .detail-line { display: flex; align-items: center; justify-content: space-between; gap: .375rem; --chip-height: 1.125rem; --chip-font-size: .6875rem }
    .pulse-meta { display: flex; gap: .375rem; font-size: .6875rem; color: var(--mut); font-family: var(--mono) }
    .row:hover { background: var(--hover) }
    .row[aria-current='true'] { background: var(--active); box-shadow: inset 2px 0 0 var(--accent); font-weight: 500 }
    .row.closed { opacity: .5 }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .row .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  `,
})
export class ManagerGroupComponent {
  private readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  protected readonly watchedSessionId = inject(WatchedSession).id;
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
        const hasNoPulse = isClosed || !view;
        const countdown = hasNoPulse ? NO_PULSE_LABEL : countdownLabel(countdownSecondsUntil(view.nextPulseAt, now));
        const countdownTip = hasNoPulse ? 'No pulse — manager closed' : `Next pulse in ${countdown}`;
        return { session, view, countdown, countdownTip };
      });
  });

  protected visibleNameOf(session: Session): string {
    return showInvisibleControlsAsEscapes(session.name);
  }

  protected open(session: Session): void {
    void this.router.navigate(['/manager', session.id]);
  }
}
