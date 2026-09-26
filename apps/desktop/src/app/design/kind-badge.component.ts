import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type InboxKind = 'gate' | 'question' | 'law' | 'permission' | 'resource';

const COLOR_VAR: Record<InboxKind, string> = {
  gate: '--state-waiting-permission',
  question: '--state-waiting-input',
  law: '--state-thinking',
  permission: '--state-generating',
  resource: '--state-closed',
};

@Component({
  selector: 'of-kind-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span data-testid="kind-badge" [style.color]="'var(' + colorVar() + ')'" class="badge">{{ kind().toUpperCase() }}</span>
  `,
  styles: `
    .badge {
      display: inline-flex; padding: 0 .375rem; border-radius: .1875rem;
      background: color-mix(in oklch, currentColor 14%, transparent);
      font-family: var(--mono); font-size: .5625rem; font-weight: 600; letter-spacing: .04em;
    }
  `,
})
export class KindBadgeComponent {
  readonly kind = input.required<InboxKind>();
  protected readonly colorVar = computed(() => COLOR_VAR[this.kind()]);
}
