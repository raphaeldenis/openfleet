import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

type ShownTheme = 'dark' | 'light';

const ICON_BY_THEME = { dark: '☾', light: '☀' } as const;
const OTHER_THEME = { dark: 'light', light: 'dark' } as const;

/** Icon button that shows the current theme and asks to switch to the other one on click; it is pressed while the theme is dark. */
@Component({
  selector: 'of-theme-toggle-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="theme-toggle" data-testid="theme-toggle" [attr.aria-label]="accessibleName()" [title]="switchTitle()" [attr.aria-pressed]="isDark()" (click)="toggled.emit()">
      <span aria-hidden="true">{{ icon() }}</span>
    </button>
  `,
  styles: `
    .theme-toggle {
      flex: none; width: 1.75rem; height: 1.75rem; border: 1px solid transparent; border-radius: .375rem;
      background: transparent; color: var(--mut); font-size: .875rem; cursor: pointer; outline: 0;
    }
    .theme-toggle:hover { background: var(--hover); color: var(--fg); }
    .theme-toggle:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
  `,
})
export class ThemeToggleButtonComponent {
  readonly theme = input.required<ShownTheme>();
  readonly toggled = output<void>();
  protected readonly isDark = computed(() => this.theme() === 'dark');
  protected readonly icon = computed(() => ICON_BY_THEME[this.theme()]);
  protected readonly accessibleName = computed(() => (this.isDark() ? 'Dark theme' : 'Light theme'));
  protected readonly switchTitle = computed(() => `Switch to ${OTHER_THEME[this.theme()]} theme`);
}
