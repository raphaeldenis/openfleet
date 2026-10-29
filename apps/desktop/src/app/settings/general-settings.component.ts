import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { NotificationDispatcher } from '../core/notification-dispatcher.service';
import { NotificationPrefsStore } from '../core/notification-prefs.store';
import { ThemeService } from '../core/theme.service';
import { DocsRootSettingComponent } from './docs-root-setting.component';
import { ProjectsSettingsComponent } from './projects-settings.component';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

const THEME_LABELS = { light: 'Light', dark: 'Dark' } as const;

type NotificationRowPref = 'enabled' | 'muted' | 'agentFinished' | 'needsInput' | 'dockBadge' | 'toolCompletion' | 'chatMessage';

const NOTIFICATION_ROWS: readonly { pref: NotificationRowPref; name: string; detail: string; testId: string }[] = [
  { pref: 'enabled', name: 'Notifications', detail: 'System banners when a session needs you or finishes', testId: 'general-notify-enabled' },
  { pref: 'muted', name: 'Mute', detail: 'Silences every banner without changing the choices below', testId: 'general-notify-muted' },
  { pref: 'agentFinished', name: 'Agent finished', detail: 'A banner when an agent finishes its turn', testId: 'general-notify-agent-finished' },
  { pref: 'needsInput', name: 'Needs input', detail: 'A banner when a session waits for a permission or an answer', testId: 'general-notify-needs-input' },
  { pref: 'dockBadge', name: 'Dock badge', detail: 'The Inbox count on the Dock icon', testId: 'general-notify-dock-badge' },
  { pref: 'toolCompletion', name: 'Tool completion', detail: 'Can be frequent: one run of many tools shows one banner per 15 seconds', testId: 'general-notify-tool-completion' },
  { pref: 'chatMessage', name: 'Chat message', detail: 'A banner when an agent asks you something', testId: 'general-notify-chat-message' },
];

@Component({
  selector: 'of-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsSectionComponent, SettingsRowComponent, ProjectsSettingsComponent, DocsRootSettingComponent],
  template: `
    <of-settings-section heading="General" testId="settings-general">
      <div class="rows">
        <of-settings-row name="Setup" detail="Replay the first-run stepper; each step shows current values with Keep / Change">
          <button type="button" class="value" data-testid="general-run-setup" (click)="runSetupAgain()">Run setup again →</button>
        </of-settings-row>
        <of-settings-row name="Theme" detail="Also switchable from the sidebar footer">
          <button type="button" class="value" data-testid="general-theme" [attr.aria-label]="themeButtonLabel()" (click)="theme.toggle()">{{ themeLabel() }}</button>
        </of-settings-row>
        <of-docs-root-setting />
        <of-settings-row name="Write a handoff when a session closes" detail="Saved to handoffs/YYYY-MM-DD-<session>.md; offered in the close dialog" [unavailable]="handoffOnClose" />
        <of-settings-row name="Agents reply and write in" detail="Applies to sessions started afterwards · code and commits follow House rules" [unavailable]="replyLanguage" />
        @for (row of notificationRows; track row.pref) {
          <of-settings-row [name]="row.name" [detail]="row.detail">
            <button type="button" class="value" role="switch" [attr.aria-label]="row.name" [attr.aria-checked]="prefs()[row.pref]" [attr.data-testid]="row.testId" (click)="toggle(row.pref)">{{ prefs()[row.pref] ? 'On' : 'Off' }}</button>
          </of-settings-row>
        }
      </div>
      @if (dispatcher.isPermissionDenied()) {
        <p class="hint" data-testid="notifications-permission-hint">Notifications are off for OpenFleet in System Settings.</p>
      }
      <of-projects-settings />
    </of-settings-section>
  `,
  styles: SETTINGS_VALUE_STYLES,
})
export class GeneralSettingsComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly dispatcher = inject(NotificationDispatcher);
  private readonly prefsStore = inject(NotificationPrefsStore);
  private readonly router = inject(Router);

  protected readonly prefs = this.prefsStore.prefs;
  protected readonly notificationRows = NOTIFICATION_ROWS;
  protected readonly handoffOnClose = { testId: 'general-handoff-on-close', value: 'Set in config.json', reason: 'Set handoff.writeOnClose in config.json' };
  protected readonly replyLanguage = { testId: 'general-reply-language', value: '—', reason: 'Not available yet — no language setting in the daemon' };
  protected readonly themeLabel = computed(() => THEME_LABELS[this.theme.theme()]);
  protected readonly themeButtonLabel = computed(() => `Theme: ${this.themeLabel()} · switch`);

  protected toggle(pref: NotificationRowPref): void {
    this.prefsStore.set(pref, !this.prefs()[pref]);
  }

  protected runSetupAgain(): void {
    void this.router.navigateByUrl('/onboarding', { state: { returnUrl: '/settings' } });
  }
}
