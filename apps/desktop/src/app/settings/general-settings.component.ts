import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ThemeService } from '../core/theme.service';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

const THEME_LABELS = { light: 'Light', dark: 'Dark' } as const;
const DOCS_ROOT_UNAVAILABLE = 'Not configurable in this build yet';

@Component({
  selector: 'of-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsSectionComponent, SettingsRowComponent],
  template: `
    <of-settings-section heading="General" testId="settings-general">
      <div class="rows">
        <of-settings-row name="Setup" detail="Replay the first-run stepper; each step shows current values with Keep / Change">
          <button type="button" class="value" data-testid="general-run-setup" (click)="runSetupAgain()">Run setup again →</button>
        </of-settings-row>
        <of-settings-row name="Theme" detail="Follows the toolbar toggle">
          <button type="button" class="value" data-testid="general-theme" [attr.aria-label]="themeButtonLabel()" (click)="theme.toggle()">{{ themeLabel() }}</button>
        </of-settings-row>
        <of-settings-row name="Docs folder root" [detail]="docsRootDetail">
          <button type="button" class="value mono" data-testid="general-docs-root" disabled>—</button>
        </of-settings-row>
      </div>
    </of-settings-section>
  `,
  styles: SETTINGS_VALUE_STYLES,
})
export class GeneralSettingsComponent {
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  protected readonly docsRootDetail = `Each project gets <root>/<project>/ with specs, plans, handoffs, reports · ${DOCS_ROOT_UNAVAILABLE}`;
  protected readonly themeLabel = computed(() => THEME_LABELS[this.theme.theme()]);
  protected readonly themeButtonLabel = computed(() => `Theme: ${this.themeLabel()} · switch`);

  protected runSetupAgain(): void {
    void this.router.navigateByUrl('/onboarding', { state: { returnUrl: '/settings' } });
  }
}
