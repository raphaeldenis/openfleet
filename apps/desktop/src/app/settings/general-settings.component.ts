import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ThemeService } from '../core/theme.service';
import { ProjectsSettingsComponent } from './projects-settings.component';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

const THEME_LABELS = { light: 'Light', dark: 'Dark' } as const;

@Component({
  selector: 'of-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsSectionComponent, SettingsRowComponent, ProjectsSettingsComponent],
  template: `
    <of-settings-section heading="General" testId="settings-general">
      <div class="rows">
        <of-settings-row name="Setup" detail="Replay the first-run stepper; each step shows current values with Keep / Change">
          <button type="button" class="value" data-testid="general-run-setup" (click)="runSetupAgain()">Run setup again →</button>
        </of-settings-row>
        <of-settings-row name="Theme" detail="Follows the toolbar toggle">
          <button type="button" class="value" data-testid="general-theme" [attr.aria-label]="themeButtonLabel()" (click)="theme.toggle()">{{ themeLabel() }}</button>
        </of-settings-row>
        <of-settings-row name="Docs folder root" detail="Each project gets <root>/<project>/ with specs, plans, handoffs, reports" [unavailable]="docsRoot" />
        <of-settings-row name="Write a handoff when a session closes" detail="Saved to handoffs/YYYY-MM-DD-<session>.md; offered in the close dialog" [unavailable]="handoffOnClose" />
        <of-settings-row name="Agents reply and write in" detail="Applies to sessions started afterwards · code and commits follow House rules" [unavailable]="replyLanguage" />
      </div>
      <of-projects-settings />
    </of-settings-section>
  `,
  styles: SETTINGS_VALUE_STYLES,
})
export class GeneralSettingsComponent {
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  protected readonly docsRoot = { testId: 'general-docs-root', value: '—', reason: 'Not configurable in this build yet' };
  protected readonly handoffOnClose = { testId: 'general-handoff-on-close', value: 'Set in config.json', reason: 'Set handoff.writeOnClose in config.json' };
  protected readonly replyLanguage = { testId: 'general-reply-language', value: '—', reason: 'Not available yet — no language setting in the daemon' };
  protected readonly themeLabel = computed(() => THEME_LABELS[this.theme.theme()]);
  protected readonly themeButtonLabel = computed(() => `Theme: ${this.themeLabel()} · switch`);

  protected runSetupAgain(): void {
    void this.router.navigateByUrl('/onboarding', { state: { returnUrl: '/settings' } });
  }
}
