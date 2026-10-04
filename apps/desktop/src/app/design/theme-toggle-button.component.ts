import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

type ShownTheme = 'dark' | 'light';

const LABEL_BY_THEME = { dark: '☾ Dark', light: '☀ Light' } as const;
const OTHER_THEME = { dark: 'light', light: 'dark' } as const;

/** Top-bar button that names the current theme and asks to switch to the other one on click. */
@Component({
  selector: 'of-theme-toggle-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="of-btn of-btn--secondary theme-toggle" data-testid="theme-toggle" [title]="switchTitle()" [attr.aria-pressed]="isDark()" (click)="toggled.emit()">
      {{ label() }}
    </button>
  `,
  styles: `
    .theme-toggle { flex: none; white-space: nowrap; }
  `,
})
export class ThemeToggleButtonComponent {
  readonly theme = input.required<ShownTheme>();
  readonly toggled = output<void>();
  protected readonly isDark = computed(() => this.theme() === 'dark');
  protected readonly label = computed(() => LABEL_BY_THEME[this.theme()]);
  protected readonly switchTitle = computed(() => `Switch to ${OTHER_THEME[this.theme()]} theme`);
}
