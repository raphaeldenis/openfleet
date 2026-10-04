import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ThemeService, otherTheme } from '../core/theme.service';

const LABEL_BY_THEME = { dark: '☾ Dark', light: '☀ Light' } as const;

/** Top-bar button that names the current theme and switches to the other one on click. */
@Component({
  selector: 'of-theme-toggle-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="of-btn of-btn--secondary theme-toggle" data-testid="theme-toggle" [title]="switchTitle()" (click)="theme.toggle()">
      {{ label() }}
    </button>
  `,
  styles: `
    .theme-toggle { flex: none; white-space: nowrap; }
  `,
})
export class ThemeToggleButtonComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly label = computed(() => LABEL_BY_THEME[this.theme.theme()]);
  protected readonly switchTitle = computed(() => `Switch to ${otherTheme(this.theme.theme())} theme`);
}
