import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import type { ManagerView } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { PulseRingComponent } from '../design/pulse-ring.component';
import { countdownLabel, countdownSecondsUntil } from './manager-countdown';
import { PulseNowAction } from './pulse-now';

@Component({
  selector: 'of-manager-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PulseRingComponent],
  template: `
    <div class="card" [attr.data-testid]="'manager-' + manager().sessionId + '-card'">
      <span [attr.data-testid]="'manager-' + manager().sessionId + '-children'">{{ manager().childrenCount }}/{{ manager().childrenCap }}</span>
      <of-pulse-ring [fractionElapsed]="fractionElapsed()" label="Next pulse" />
      <span [attr.data-testid]="'manager-' + manager().sessionId + '-countdown'">{{ countdownDisplay() }}</span>
      <button
        type="button"
        class="of-btn of-btn--secondary"
        [attr.data-testid]="'manager-' + manager().sessionId + '-pulse'"
        [disabled]="pulse.pending()"
        (click)="pulseNow()"
      >Pulse now</button>
      @if (pulse.message(); as message) {
        <span
          [attr.data-testid]="'manager-' + manager().sessionId + '-pulse-message'"
          [attr.role]="message.kind === 'error' ? 'alert' : 'status'"
        >{{ message.text }}</span>
      }
    </div>
  `,
  styles: `
    .card {
      display: flex; align-items: center; gap: .5rem;
      padding: .125rem .5rem .5rem 1.6rem; font-size: .6875rem; color: var(--mut);
    }
  `,
})
export class ManagerCardComponent {
  readonly manager = input.required<ManagerView>();
  protected readonly pulse = new PulseNowAction(inject(FleetApiService));
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected readonly countdownSeconds = computed(() => countdownSecondsUntil(this.manager().nextPulseAt, this.now()));

  protected readonly countdownDisplay = computed(() => countdownLabel(this.countdownSeconds()));

  protected readonly fractionElapsed = computed(() => {
    const pulseSeconds = this.manager().pulseSeconds;
    const secondsRemaining = this.countdownSeconds();
    if (pulseSeconds <= 0 || secondsRemaining === null) return 0;
    return Math.min(1, Math.max(0, 1 - secondsRemaining / pulseSeconds));
  });

  pulseNow(): void {
    void this.pulse.run(this.manager().sessionId);
  }
}
