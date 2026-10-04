import { ChangeDetectionStrategy, Component } from '@angular/core';
import { environment } from '../../environments/environment';
import { SettingsRowComponent } from './settings-row.component';
import { SettingsSectionComponent } from './settings-section.component';
import { SETTINGS_VALUE_STYLES } from './settings-value-styles';

/** Where the desktop app writes the daemon log when `OPENFLEET_HOME` is not set. */
export const DAEMON_LOG_PATH = '~/.openfleet/logs/daemon.log';

/** Where the daemon reads its hand-edited configuration when `OPENFLEET_HOME` is not set. */
const DAEMON_CONFIG_PATH = '~/.openfleet/config.json';

@Component({
  selector: 'of-daemon-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsSectionComponent, SettingsRowComponent],
  template: `
    <of-settings-section heading="Daemon" testId="settings-daemon">
      <div class="rows">
        <of-settings-row name="Address" detail="Local only">
          <span class="value mono" data-testid="daemon-address">{{ daemonAddress }}</span>
        </of-settings-row>
        <of-settings-row name="Admin token" detail="Read from ~/.openfleet/admin.token · created on first daemon start">
          <span class="value mono" data-testid="admin-token-status">{{ adminTokenStatus }}</span>
        </of-settings-row>
        <of-settings-row name="Log">
          <span class="value mono" data-testid="daemon-log-path">{{ logPath }}</span>
        </of-settings-row>
        <of-settings-row name="Config file" detail="Edited by hand for now · restart the daemon after changes">
          <span class="value mono" data-testid="daemon-config-path">{{ configPath }}</span>
        </of-settings-row>
      </div>
    </of-settings-section>
  `,
  styles: SETTINGS_VALUE_STYLES,
})
export class DaemonSettingsComponent {
  protected readonly daemonAddress = environment.daemonAddress;
  protected readonly logPath = DAEMON_LOG_PATH;
  protected readonly configPath = DAEMON_CONFIG_PATH;
  /** Says whether the app holds a token; the token itself is never read into the view. */
  protected readonly adminTokenStatus = environment.adminToken.trim() !== '' ? 'found' : 'missing';
}
