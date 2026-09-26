import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

@Component({
  selector: 'of-pulse-ring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg width="14" height="14" viewBox="0 0 14 14" [style.transform]="'rotate(-90deg)'">
      <circle cx="7" cy="7" [attr.r]="radius" fill="none" stroke="var(--line-2)" stroke-width="2" />
      <circle
        data-testid="pulse-ring-progress"
        cx="7" cy="7" [attr.r]="radius" fill="none" stroke="var(--accent)" stroke-width="2"
        [attr.stroke-dasharray]="drawnLength() + ' ' + circumference"
      />
    </svg>
  `,
})
export class PulseRingComponent {
  readonly fractionElapsed = input.required<number>();
  protected readonly radius = RADIUS;
  protected readonly circumference = CIRCUMFERENCE.toFixed(1);
  protected readonly drawnLength = computed(() => (Math.round(this.fractionElapsed() * CIRCUMFERENCE * 10) / 10).toString());
}
