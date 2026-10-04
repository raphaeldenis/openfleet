import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type InboxKind = 'gate' | 'question' | 'law' | 'permission' | 'resource' | 'issue' | 'notice';

const COLOR_VAR: Record<InboxKind, string> = {
  issue: '--state-error',
  notice: '--state-idle',
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
    <span data-testid="kind-badge" class="of-badge kind-badge" [style.--kind-color]="'var(' + colorVar() + ')'">
      <span class="dot" aria-hidden="true"></span>{{ kind().toUpperCase() }}
    </span>
  `,
  styles: `
    .kind-badge {
      gap: .25rem; color: var(--fg); font-family: var(--mono);
      border: 1px solid color-mix(in oklch, var(--kind-color) 40%, transparent);
      background: color-mix(in oklch, var(--kind-color) 14%, transparent);
    }
    .dot { width: .375rem; height: .375rem; border-radius: 50%; background: var(--kind-color); }
  `,
})
export class KindBadgeComponent {
  readonly kind = input.required<InboxKind>();
  protected readonly colorVar = computed(() => COLOR_VAR[this.kind()]);
}
