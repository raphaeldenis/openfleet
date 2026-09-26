import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import type { ManagerView } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { PulseRingComponent } from '../design/pulse-ring.component';

@Component({
  selector: 'of-manager-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PulseRingComponent],
  template: `
    <div class="card" [attr.data-testid]="'manager-' + manager().sessionId + '-card'">
      <span [attr.data-testid]="'manager-' + manager().sessionId + '-children'">{{ manager().childrenCount }}/{{ manager().childrenCap }}</span>
      <of-pulse-ring [fractionElapsed]="fractionElapsed()" label="Next pulse" />
      <span [attr.data-testid]="'manager-' + manager().sessionId + '-countdown'">{{ countdownSeconds() }}s</span>
      <button
        type="button"
        class="of-btn of-btn--secondary"
        [attr.data-testid]="'manager-' + manager().sessionId + '-pulse'"
        (click)="pulseNow()"
      >Pulse now</button>
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
  private readonly api = inject(FleetApiService);
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected readonly countdownSeconds = computed(() =>
    Math.max(0, Math.round((new Date(this.manager().nextPulseAt).getTime() - this.now()) / 1000)),
  );

  protected readonly fractionElapsed = computed(() => {
    const pulseSeconds = this.manager().pulseSeconds;
    if (pulseSeconds <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - this.countdownSeconds() / pulseSeconds));
  });

  pulseNow(): void {
    void this.api.pulseNow(this.manager().sessionId);
  }
}
