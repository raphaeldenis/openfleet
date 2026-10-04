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
    <span data-testid="actor-badge" class="of-badge actor-badge" [style.--actor-color]="'var(' + colorVar() + ')'">
      <span class="dot" aria-hidden="true"></span>{{ kind().toUpperCase() }}
    </span>
  `,
  styles: `
    .actor-badge {
      gap: .25rem; color: var(--fg); font-family: var(--mono);
      border: 1px solid color-mix(in oklch, var(--actor-color) 45%, transparent);
      background: color-mix(in oklch, var(--actor-color) 14%, transparent);
    }
    .dot { width: .375rem; height: .375rem; border-radius: 50%; background: var(--actor-color); }
  `,
})
export class ActorBadgeComponent {
  readonly kind = input.required<RowActorKind>();
  protected readonly colorVar = computed(() => COLOR_VAR[this.kind()]);
}
