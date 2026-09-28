import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { FleetApiService } from '../core/fleet-api.service';

type SettingsTab = 'models' | 'daemon';

const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'models', label: 'Models' },
  { key: 'daemon', label: 'Daemon' },
];

const MODEL_RUNGS: ReadonlyArray<{ rung: string; description: string }> = [
  { rung: 'haiku', description: 'Cheapest rung' },
  { rung: 'sonnet', description: 'Default for workers' },
  { rung: 'opus', description: 'Default for managers' },
  { rung: 'fable', description: 'Experimental rung' },
];

const MODEL_TABLE_EDIT_HINT = 'Read-only. To change a rung, edit models in ~/.openfleet/config.json by hand and restart the daemon.';

@Component({
  selector: 'of-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings" data-testid="settings">
      <div class="tabs" role="tablist" aria-orientation="vertical">
        @for (tab of tabs; track tab.key) {
          <button type="button" role="tab" class="tab" [class.active]="activeTab() === tab.key" [attr.aria-selected]="activeTab() === tab.key" (click)="activeTab.set(tab.key)">{{ tab.label }}</button>
        }
      </div>
      <div class="content">
        @if (activeTab() === 'models') {
          <section class="panel" data-testid="settings-models">
            <h1>Models</h1>
            @if (modelsFailed()) {
              <p class="error" data-testid="models-error">✕ Couldn’t load the model table from the daemon.</p>
            } @else if (modelTable(); as table) {
              <div class="rows">
                @for (row of rungs; track row.rung) {
                  <div class="row" [attr.data-testid]="'model-row-' + row.rung">
                    <div class="label"><span class="name">{{ row.rung }}</span><span class="detail">{{ row.description }}</span></div>
                    <span class="value mono">{{ table[row.rung] }}</span>
                  </div>
                }
              </div>
              <p class="hint" data-testid="models-edit-hint" [title]="editHint">Read-only · edited by hand in ~/.openfleet/config.json</p>
            } @else {
              <p class="detail" data-testid="models-loading">Loading…</p>
            }
          </section>
        } @else {
          <section class="panel" data-testid="settings-daemon">
            <h1>Daemon</h1>
            <div class="rows">
              <div class="row">
                <div class="label"><span class="name">Address</span><span class="detail">Local only</span></div>
                <span class="value mono" data-testid="daemon-address">{{ daemonAddress }}</span>
              </div>
              <div class="row">
                <div class="label"><span class="name">Admin token</span><span class="detail">Read from ~/.openfleet/admin.token · created on first daemon start</span></div>
                <span class="value mono" data-testid="admin-token-status">{{ isAdminTokenFound ? 'found' : 'not found' }}</span>
              </div>
            </div>
          </section>
        }
      </div>
    </div>
  `,
  styles: `
    .settings { flex: 1; display: flex; min-height: 0; }
    .tabs { width: 13rem; flex: none; padding: .75rem .5rem; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; gap: .0625rem; }
    .tab { height: 1.75rem; display: flex; align-items: center; padding: 0 .625rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
    .tab.active { background: var(--active); }
    .content { flex: 1; min-width: 0; overflow: auto; padding: 1.25rem 1.5rem 3rem; }
    .panel { max-width: 40rem; display: flex; flex-direction: column; gap: 1rem; }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
    .rows { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .row { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    .label { flex: 1; display: flex; flex-direction: column; }
    .name { font-weight: 500; }
    .detail { font-size: .75rem; color: var(--mut); }
    .value { min-width: 8rem; padding: .3125rem .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); font-size: .75rem; }
    .mono { font-family: var(--mono); }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); cursor: help; }
    .error { margin: 0; color: var(--s-err); }
  `,
})
export class SettingsComponent {
  private readonly api = inject(FleetApiService);

  protected readonly tabs = SETTINGS_TABS;
  protected readonly rungs = MODEL_RUNGS;
  protected readonly editHint = MODEL_TABLE_EDIT_HINT;
  protected readonly daemonAddress = environment.daemonAddress;
  protected readonly isAdminTokenFound = environment.adminToken !== '';

  protected readonly activeTab = signal<SettingsTab>('models');
  protected readonly modelTable = signal<Record<string, string> | null>(null);
  protected readonly modelsFailed = signal(false);

  constructor() {
    void this.loadModelTable();
  }

  private async loadModelTable(): Promise<void> {
    try {
      this.modelTable.set(await this.api.models());
    } catch {
      this.modelsFailed.set(true);
    }
  }
}
