import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import type { ManagerView, Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { StateChipComponent } from '../design/state-chip.component';
import { PulseRingComponent } from '../design/pulse-ring.component';
import { countdownLabel, countdownSecondsUntil } from './manager-countdown';
import { PulseNowAction } from './pulse-now';

@Component({
  selector: 'of-manager-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent, PulseRingComponent],
  template: `
    @if (session(); as session) {
      <header class="header" data-testid="manager-dashboard">
        <span class="emoji">{{ session.emoji }}</span>
        <div class="identity">
          <div class="name-row">
            <span data-testid="manager-dashboard-name" class="name">{{ session.name }}</span>
            <span class="role-badge">manager</span>
            <of-state-chip [state]="session.state" />
          </div>
        </div>
        @if (manager(); as manager) {
          <div class="cap" title="Children cap headroom">
            <span>Children</span>
            <span data-testid="manager-dashboard-cap" class="mono">{{ manager.childrenCount }}/{{ manager.childrenCap }}</span>
          </div>
          <div class="pulse">
            <of-pulse-ring [fractionElapsed]="fractionElapsed()" label="Next pulse" />
            <span data-testid="manager-dashboard-countdown" class="mono">{{ countdownDisplay() }}</span>
          </div>
        }
        <button
          type="button"
          class="of-btn of-btn--primary"
          data-testid="manager-dashboard-pulse"
          [disabled]="pulse.pending()"
          (click)="pulseNow()"
        >Pulse now</button>
        @if (pulse.message(); as message) {
          <span
            data-testid="manager-dashboard-pulse-message"
            [attr.role]="message.kind === 'error' ? 'alert' : 'status'"
          >{{ message.text }}</span>
        }
      </header>

      <section class="children">
        <div class="section-head">
          <span class="title">Children</span>
        </div>
        @if (children().length > 0) {
          <div class="table">
            <div class="row head">
              <span class="col-name">Name</span>
              <span class="col-state">State</span>
              <span class="col-cost">Cost</span>
            </div>
            @for (child of children(); track child.id) {
              <div class="row" [attr.data-testid]="'manager-dashboard-child-' + child.id">
                <span class="col-name">{{ child.emoji }} {{ child.name }}</span>
                <span class="col-state"><of-state-chip [state]="child.state" /></span>
                <span class="col-cost mono" title="Cost tracking is not implemented yet">—</span>
              </div>
            }
          </div>
        } @else {
          <p class="empty">No children yet — the manager spawns workers on its next pulse.</p>
        }
      </section>

      <p class="notice" data-testid="manager-dashboard-governance-notice">Journal and proposals are coming once notes/governance land.</p>
    }
  `,
  styles: `
    .header { display: flex; align-items: center; flex-wrap: wrap; gap: .625rem .75rem; padding: .875rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel) }
    .emoji { width: 2.5rem; height: 2.5rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); display: flex; align-items: center; justify-content: center; font-size: 1.25rem }
    .identity { display: flex; flex-direction: column; min-width: 0 }
    .name-row { display: flex; align-items: center; gap: .5rem }
    .name { font-size: 1rem; font-weight: 600 }
    .role-badge { font-size: .6875rem; padding: 0 .375rem; border: 1px solid var(--line-2); border-radius: .25rem; color: var(--mut) }
    .cap { display: flex; flex-direction: column; gap: .25rem; width: 8rem; font-size: .6875rem; color: var(--mut) }
    .pulse { display: flex; align-items: center; gap: .5rem; font-size: .6875rem }
    .mono { font-family: var(--mono) }
    .children { margin: 1.25rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel) }
    .section-head { display: flex; align-items: center; padding: .625rem .875rem; border-bottom: 1px solid var(--line) }
    .title { font-weight: 600; flex: 1 }
    .table { display: flex; flex-direction: column }
    .row { display: flex; align-items: center; gap: .5rem; padding: .5rem .875rem; border-bottom: 1px solid var(--line); font-size: .75rem }
    .row.head { color: var(--faint); font-size: .6875rem }
    .col-name { flex: 1.5; display: flex; align-items: center; gap: .375rem; font-weight: 500 }
    .col-state { flex: 1 }
    .col-cost { width: 4rem; text-align: right }
    .empty { padding: 2rem; text-align: center; color: var(--mut) }
    .notice { margin: 0 1.25rem 1.25rem; color: var(--mut); font-size: .8125rem }
  `,
})
export class ManagerDashboardComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly events = inject(FleetEventsService);
  protected readonly pulse = new PulseNowAction(inject(FleetApiService));
  private readonly managerId = toSignal(this.route.paramMap.pipe(map((params) => params.get('id') ?? '')), { initialValue: '' });
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected readonly session = computed<Session | undefined>(() =>
    this.events.sessions().find((s) => s.id === this.managerId()),
  );

  protected readonly manager = computed<ManagerView | undefined>(() =>
    this.events.managers().find((m) => m.sessionId === this.managerId()),
  );

  protected readonly children = computed<Session[]>(() =>
    this.events.sessions().filter((s) => s.parentId === this.managerId()),
  );

  protected readonly countdownSeconds = computed(() => {
    const manager = this.manager();
    return manager ? countdownSecondsUntil(manager.nextPulseAt, this.now()) : null;
  });

  protected readonly countdownDisplay = computed(() => countdownLabel(this.countdownSeconds()));

  protected readonly fractionElapsed = computed(() => {
    const manager = this.manager();
    const secondsRemaining = this.countdownSeconds();
    if (!manager || manager.pulseSeconds <= 0 || secondsRemaining === null) return 0;
    return Math.min(1, Math.max(0, 1 - secondsRemaining / manager.pulseSeconds));
  });

  pulseNow(): void {
    void this.pulse.run(this.managerId());
  }
}
