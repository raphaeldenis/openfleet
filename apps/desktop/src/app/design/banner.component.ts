import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type BannerVariant = 'permission' | 'reconnecting' | 'error' | 'done';

const COLOR_VAR: Record<BannerVariant, string> = {
  permission: '--state-waiting-permission',
  reconnecting: '--state-waiting-permission',
  error: '--state-error',
  done: '--state-idle',
};

@Component({
  selector: 'of-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-testid="banner" [attr.data-variant]="variant()" [style.--banner-color]="'var(' + colorVar() + ')'" class="banner">
      <span class="title">{{ title() }}</span>
      <span>{{ description() }}</span>
    </div>
  `,
  styles: `
    .banner {
      display: flex; gap: .75rem; padding: .625rem .875rem; border-radius: .5rem;
      border: 1px solid color-mix(in oklch, var(--banner-color) 45%, transparent);
      background: color-mix(in oklch, var(--banner-color) 7%, var(--panel));
    }
    .title { color: var(--banner-color); font-weight: 600; }
  `,
})
export class BannerComponent {
  readonly variant = input.required<BannerVariant>();
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  protected readonly colorVar = computed(() => COLOR_VAR[this.variant()]);
}
