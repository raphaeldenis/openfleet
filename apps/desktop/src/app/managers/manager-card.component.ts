import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import type { ManagerView, Session } from '@openfleet/shared';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { FleetApiService } from '../core/fleet-api.service';
import { PulseRingComponent } from '../design/pulse-ring.component';
import { OverdueChipComponent } from '../working-state/overdue-chip.component';
import { countdownLabel, countdownSecondsUntil } from './manager-countdown';
import { ManagerLinksComponent } from './manager-links.component';
import { PulseNowAction } from './pulse-now';
import { PulsePauseAction } from './pulse-pause';

@Component({
  selector: 'of-manager-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PulseRingComponent, OverdueChipComponent, ManagerLinksComponent],
  template: `
    <div class="card" [attr.data-testid]="'manager-' + manager().sessionId + '-card'">
      <span [attr.data-testid]="'manager-' + manager().sessionId + '-children'">{{ manager().childrenCount }}/{{ manager().childrenCap }}</span>
      <of-pulse-ring [fractionElapsed]="fractionElapsed()" label="Next pulse" />
      <span [attr.data-testid]="'manager-' + manager().sessionId + '-countdown'">{{ countdownDisplay() }}</span>
      @if (session(); as managerSession) {
        <of-overdue-chip [session]="managerSession" />
      }
      <button
        type="button"
        class="of-btn of-btn--secondary"
        [attr.data-testid]="'manager-' + manager().sessionId + '-pulse'"
        [disabled]="pulse.pending() || isSessionClosed() || isPaused()"
        (click)="pulseNow()"
      >Pulse now</button>
      <button
        type="button"
        class="of-btn of-btn--secondary"
        [attr.data-testid]="'manager-' + manager().sessionId + '-pause'"
        [attr.aria-label]="pauseButtonName()"
        [attr.aria-pressed]="isPaused()"
        [disabled]="pauseAction.pending() || isSessionClosed()"
        (click)="togglePause()"
      >{{ pauseButtonLabel() }}</button>
      <of-manager-links [manager]="manager()" [projectId]="session()?.projectId" [managerName]="session()?.name" />
      @if (displayedMessage(); as message) {
        <span
          [attr.data-testid]="'manager-' + manager().sessionId + '-pulse-message'"
          [attr.role]="message.kind === 'error' ? 'alert' : 'status'"
        >{{ message.text }}</span>
      }
    </div>
  `,
  styles: `
    .card {
      display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem;
      padding: .125rem .5rem .5rem 1.6rem; font-size: .6875rem; color: var(--mut);
    }
  `,
})
export class ManagerCardComponent {
  readonly manager = input.required<ManagerView>();
  readonly session = input<Session | undefined>(undefined);
  private readonly api = inject(FleetApiService);
  protected readonly pulse = new PulseNowAction(this.api);
  protected readonly pauseAction = new PulsePauseAction(this.api);
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected readonly isSessionClosed = computed(() => this.session()?.state === 'closed');

  protected readonly countdownSeconds = computed(() => countdownSecondsUntil(this.manager().nextPulseAt, this.now()));

  protected readonly isPaused = computed(() => this.manager().pulseEnabled === false);

  protected readonly pauseButtonLabel = computed(() => (this.isPaused() ? 'Resume pulses' : 'Pause pulses'));

  protected readonly pauseButtonName = computed(() => {
    const managerName = this.session()?.name;
    return managerName === undefined ? null : `${this.pauseButtonLabel()} of ${showInvisibleControlsAsEscapes(managerName)}`;
  });

  protected readonly countdownDisplay = computed(() => {
    if (this.isSessionClosed()) return 'closed';
    if (this.isPaused()) return 'paused';
    return countdownLabel(this.countdownSeconds());
  });

  protected readonly displayedMessage = computed(() =>
    this.pulse.message() ?? this.pauseAction.message() ?? (this.isSessionClosed() ? { text: 'This session is closed', kind: 'info' as const } : null),
  );

  protected readonly fractionElapsed = computed(() => {
    const pulseSeconds = this.manager().pulseSeconds;
    const secondsRemaining = this.countdownSeconds();
    if (this.isPaused() || pulseSeconds <= 0 || secondsRemaining === null) return 0;
    return Math.min(1, Math.max(0, 1 - secondsRemaining / pulseSeconds));
  });

  pulseNow(): void {
    this.pauseAction.message.set(null);
    void this.pulse.run(this.manager().sessionId);
  }

  togglePause(): void {
    this.pulse.message.set(null);
    void this.pauseAction.toggle(this.manager());
  }
}
