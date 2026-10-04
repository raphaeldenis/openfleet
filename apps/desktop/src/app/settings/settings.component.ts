import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';
import { AboutSettingsComponent } from './about-settings.component';
import { DaemonSettingsComponent } from './daemon-settings.component';
import { DiagnosticsSettingsComponent } from './diagnostics-settings.component';
import { GeneralSettingsComponent } from './general-settings.component';
import { ModelRungsState } from './model-rungs.state';
import { ModelsSettingsComponent } from './models-settings.component';

type SettingsTab = 'general' | 'models' | 'daemon' | 'diagnostics' | 'about';

const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'models', label: 'Models' },
  { key: 'daemon', label: 'Daemon' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'about', label: 'About' },
];

@Component({
  selector: 'of-settings',
  imports: [GeneralSettingsComponent, ModelsSettingsComponent, DaemonSettingsComponent, DiagnosticsSettingsComponent, AboutSettingsComponent],
  providers: [ModelRungsState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings" data-testid="settings">
      <div class="tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" (keydown)="onTabKeydown($event)">
        @for (tab of tabs; track tab.key) {
          <button
            type="button"
            role="tab"
            class="tab"
            [class.active]="activeTab() === tab.key"
            [id]="'settings-tab-' + tab.key"
            [attr.aria-selected]="activeTab() === tab.key"
            [attr.aria-controls]="tabPanelId"
            [attr.tabindex]="activeTab() === tab.key ? 0 : -1"
            (click)="activeTab.set(tab.key)"
          >{{ tab.label }}</button>
        }
      </div>
      <div class="content" role="tabpanel" [id]="tabPanelId" [attr.aria-labelledby]="'settings-tab-' + activeTab()">
        @switch (activeTab()) {
          @case ('general') { <of-general-settings /> }
          @case ('models') { <of-models-settings /> }
          @case ('daemon') { <of-daemon-settings /> }
          @case ('diagnostics') { <of-diagnostics-settings /> }
          @case ('about') { <of-about-settings /> }
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: flex; flex: 1 1 0%; min-width: 0; min-height: 0; }
    .settings { flex: 1; display: flex; min-width: 0; min-height: 0; }
    .tabs { width: 13rem; flex: none; padding: .75rem .5rem; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; gap: .0625rem; }
    .tab { height: 1.75rem; display: flex; align-items: center; padding: 0 .625rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
    .tab.active { background: var(--active); }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .content { flex: 1; min-width: 0; overflow: auto; padding: 1.25rem 1.5rem 3rem; }
  `,
})
export class SettingsComponent {
  private readonly route = inject(ActivatedRoute, { optional: true });

  protected readonly tabs = SETTINGS_TABS;
  protected readonly tabPanelId = 'settings-tabpanel';
  protected readonly activeTab = signal<SettingsTab>('general');

  constructor() {
    void inject(ModelRungsState).load();
    this.route?.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requestedTab = SETTINGS_TABS.find((tab) => tab.key === params.get('tab'));
      if (requestedTab) this.activeTab.set(requestedTab.key);
    });
  }

  protected onTabKeydown(event: KeyboardEvent): void {
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.key === this.activeTab());
    const targetIndex = nextTabIndex(event, { currentIndex, tabCount: SETTINGS_TABS.length, orientation: 'vertical' });
    if (targetIndex === undefined) return;
    event.preventDefault();
    this.activeTab.set(SETTINGS_TABS[targetIndex].key);
    focusTabAt(event.currentTarget as HTMLElement, targetIndex);
  }
}
