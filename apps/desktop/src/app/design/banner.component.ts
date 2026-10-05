import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type BannerVariant = 'permission' | 'reconnecting' | 'mismatch' | 'error' | 'done';

const COLOR_VAR: Record<BannerVariant, string> = {
  permission: '--state-waiting-permission',
  reconnecting: '--state-waiting-permission',
  mismatch: '--state-waiting-permission',
  error: '--state-error',
  done: '--state-idle',
};

const ANNOUNCE_ROLE: Record<BannerVariant, 'alert' | 'status'> = {
  permission: 'alert',
  error: 'alert',
  reconnecting: 'status',
  mismatch: 'status',
  done: 'status',
};

@Component({
  selector: 'of-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="banner"
      [attr.data-variant]="variant()"
      [attr.data-layout]="layout()"
      [attr.role]="role()"
      [attr.aria-live]="role() === 'status' ? 'polite' : null"
      [style.--banner-color]="'var(' + colorVar() + ')'"
      class="banner"
    >
      <span class="title">@if (glyph(); as leadingGlyph) {<span class="glyph">{{ leadingGlyph }}</span>{{ ' ' }}}{{ title() }}</span>
      <span class="description">{{ description() }}</span>
      <ng-content />
    </div>
  `,
  styles: `
    .banner {
      display: flex; gap: .75rem; padding: .625rem .875rem; border-radius: .5rem;
      border: 1px solid color-mix(in oklch, var(--banner-color) 45%, transparent);
      background: color-mix(in oklch, var(--banner-color) 7%, var(--panel));
    }
    .banner { align-items: center; }
    .description { min-width: 0; flex: 1; overflow-wrap: anywhere; }
    .title { color: var(--banner-color); font-weight: 600; }
    .banner[data-variant='error'] .title, .banner[data-variant='mismatch'] .title { color: var(--fg); }
    .glyph { color: var(--banner-color); }
    .banner[data-layout='strip'] {
      padding: .5rem 1rem; border: 0; border-bottom: 1px solid var(--line); border-radius: 0;
      background: color-mix(in oklch, var(--banner-color) 10%, var(--panel)); font-size: .8125rem; color: var(--fg);
    }
    .banner[data-layout='strip'] .title { color: var(--fg); white-space: nowrap; }
    .banner[data-layout='strip'] .description { text-wrap: pretty; }
  `,
})
export class BannerComponent {
  readonly variant = input.required<BannerVariant>();
  /** A card is a bordered box inside a page; a strip runs flat across the full width of the area it tops. */
  readonly layout = input<'card' | 'strip'>('card');
  /** A symbol drawn in the banner colour before the title, such as "!". */
  readonly glyph = input<string>('');
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  protected readonly colorVar = computed(() => COLOR_VAR[this.variant()]);
  protected readonly role = computed(() => ANNOUNCE_ROLE[this.variant()]);
}
