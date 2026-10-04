import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { RowActorKind } from '@openfleet/shared';

const COLOR_VAR: Record<RowActorKind, string> = {
  human: '--state-idle',
  agent: '--state-generating',
  trigger: '--state-thinking',
};

@Component({
  selector: 'of-actor-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span data-testid="actor-badge" [style.color]="'var(' + colorVar() + ')'" class="of-badge actor-badge">{{ kind().toUpperCase() }}</span>
  `,
  styles: `
    .actor-badge { background: color-mix(in oklch, currentColor 16%, transparent); font-family: var(--mono); }
  `,
})
export class ActorBadgeComponent {
  readonly kind = input.required<RowActorKind>();
  protected readonly colorVar = computed(() => COLOR_VAR[this.kind()]);
}
