import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { SupportActions } from '../core/support-actions';
import { VersionsService } from '../core/versions.service';
import { versionMismatchNoticeOf } from '../core/version-mismatch-notice';
import { BannerComponent } from '../design/banner.component';
import { CopyDetailsButtonComponent } from '../design/copy-details-button.component';
import { ErrorLineComponent } from '../design/error-line.component';
import { DAEMON_LOG_PATH } from './daemon-settings.component';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

type SupportAction = 'logs' | 'issue';

const SUPPORT_UNAVAILABLE_TOOLTIP = 'Available in the OpenFleet desktop app';

const SUPPORT_FAILURES: Record<SupportAction, string> = {
  logs: '✕ Couldn’t open the logs folder.',
  issue: '✕ Couldn’t open the issue form.',
};

@Component({
  selector: 'of-about-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsSectionComponent, SettingsRowComponent, BannerComponent, CopyDetailsButtonComponent, ErrorLineComponent],
  template: `
    <of-settings-section heading="About" testId="settings-about">
      @if (mismatchNotice(); as notice) {
        <of-banner data-testid="about-version-mismatch" variant="mismatch" glyph="!" title="Version mismatch" [description]="notice.description">
          <of-copy-details-button testId="about-version-mismatch-copy-details" [text]="notice.detailsText" />
        </of-banner>
      }
      <div class="rows">
        <of-settings-row name="App version" detail="OpenFleet.app">
          <span class="value mono" data-testid="about-app-version">{{ versionLabelOf({ version: versions.appVersion(), isSettled: versions.isAppVersionSettled() }) }}</span>
        </of-settings-row>
        <of-settings-row name="Daemon version" [detail]="daemonAddress">
          <span class="value mono" data-testid="about-daemon-version">{{ versionLabelOf({ version: versions.daemonVersion(), isSettled: versions.isDaemonVersionSettled() }) }}</span>
        </of-settings-row>
        <of-settings-row name="Logs" [detail]="logsDetail">
          <button type="button" class="value" data-testid="about-reveal-logs" [disabled]="!support.isAvailable" [attr.title]="unavailableTooltip()" (click)="runSupportAction('logs')">Reveal logs</button>
        </of-settings-row>
        <of-settings-row name="Report an issue" detail="Opens the issue form in your browser · nothing is sent until you submit it there">
          <button type="button" class="value" data-testid="about-report-issue" aria-label="Report an issue" [disabled]="!support.isAvailable" [attr.title]="unavailableTooltip()" (click)="runSupportAction('issue')">Report…</button>
        </of-settings-row>
      </div>
      @if (supportError(); as message) {
        <p class="error" role="alert" data-testid="about-support-error"><of-error-line>{{ message }}</of-error-line></p>
      }
    </of-settings-section>
  `,
  styles: SETTINGS_VALUE_STYLES,
})
export class AboutSettingsComponent {
  protected readonly versions = inject(VersionsService);
  protected readonly support = inject(SupportActions);
  protected readonly daemonAddress = environment.daemonAddress;
  protected readonly logsDetail = `${DAEMON_LOG_PATH} and the app log · they stay on this Mac`;
  protected readonly supportError = signal<string | null>(null);

  protected readonly mismatchNotice = computed(() => {
    const mismatch = this.versions.mismatch();
    if (!mismatch) return null;
    return versionMismatchNoticeOf({
      mismatch,
      address: this.daemonAddress,
      at: new Date().toISOString(),
      ref: `OF-${crypto.randomUUID().slice(0, 6)}`,
    });
  });

  constructor() {
    void this.versions.loadAppVersion();
  }

  protected unavailableTooltip(): string | null {
    return this.support.isAvailable ? null : SUPPORT_UNAVAILABLE_TOOLTIP;
  }

  protected async runSupportAction(action: SupportAction): Promise<void> {
    this.supportError.set(null);
    try {
      await (action === 'logs' ? this.support.revealLogs() : this.support.reportIssue());
    } catch {
      this.supportError.set(SUPPORT_FAILURES[action]);
    }
  }

  protected versionLabelOf({ version, isSettled }: { version: string | null; isSettled: boolean }): string {
    if (version !== null) return version;
    return isSettled ? 'unknown' : '…';
  }
}
