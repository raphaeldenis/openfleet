import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ToolSummary } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { BannerComponent } from '../design/banner.component';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';
import { ToolkitActivityComponent } from './toolkit-activity.component';
import { ToolkitCatalogComponent } from './toolkit-catalog.component';
import { ToolkitHarnessesComponent } from './toolkit-harnesses.component';

type ToolkitTab = 'catalog' | 'activity' | 'harnesses';
type ToolsLoad = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; tools: readonly ToolSummary[] };

const TOOLKIT_TABS: ReadonlyArray<{ key: ToolkitTab; label: string }> = [
  { key: 'catalog', label: 'Catalog' },
  { key: 'activity', label: 'Activity' },
  { key: 'harnesses', label: 'Harnesses' },
];

/** What the fleet's tools are: the MCP catalog and the harnesses that call them. */
@Component({
  selector: 'of-toolkit-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, ToolkitActivityComponent, ToolkitCatalogComponent, ToolkitHarnessesComponent],
  template: `
    <section class="toolkit" data-testid="toolkit-view">
      <header class="head">
        <h1>Toolkit</h1>
        <div class="tabs" role="tablist" aria-label="Toolkit sections" (keydown)="onTabKeydown($event)">
          @for (tab of tabs; track tab.key) {
            <button
              type="button"
              role="tab"
              class="tab"
              [id]="'toolkit-tab-' + tab.key"
              [attr.aria-selected]="activeTab() === tab.key"
              [attr.aria-controls]="tabPanelId"
              [attr.tabindex]="activeTab() === tab.key ? 0 : -1"
              (click)="activeTab.set(tab.key)"
            >{{ tab.label }}</button>
          }
        </div>
      </header>

      <div class="panel" role="tabpanel" [id]="tabPanelId" [attr.aria-labelledby]="'toolkit-tab-' + activeTab()">
        @if (activeTab() === 'activity') {
          <of-toolkit-activity [tool]="activityTool()" (toolCleared)="activityTool.set(undefined)" />
        } @else {
          @switch (load().status) {
            @case ('loading') {
              <div class="loading" data-testid="toolkit-loading" role="status" aria-label="Loading tools"></div>
            }
            @case ('failed') {
              <of-banner data-testid="toolkit-error" variant="error" glyph="✕" title="Tools unavailable" description="The daemon could not list its tools.">
                <button type="button" class="of-btn of-btn--compact" (click)="reload()">Retry</button>
              </of-banner>
            }
          }

          @if (tools(); as listedTools) {
            @if (listedTools.length === 0) {
              <div class="empty" data-testid="toolkit-empty">
                <span class="empty-title">No tools</span>
                <span>The daemon lists no MCP tool.</span>
              </div>
            } @else {
              @switch (activeTab()) {
                @case ('catalog') { <of-toolkit-catalog [tools]="listedTools" (activityRequested)="showActivityOf($event)" /> }
                @case ('harnesses') { <of-toolkit-harnesses [tools]="listedTools" /> }
              }
            }
          }
        }
      </div>
    </section>
  `,
  styles: `
    :host { display: flex; flex: 1 1 0%; min-width: 0; min-height: 0; }
    .toolkit { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .head { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; padding: .625rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: .9375rem; font-weight: 600; }
    .tabs { display: flex; gap: .125rem; }
    .tab { height: 1.75rem; padding: 0 .75rem; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--mut); font: inherit; font-size: .8125rem; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .tab[aria-selected='true'] { color: var(--fg); border-bottom-color: var(--accent); }
    .tab:focus-visible { outline: .125rem solid var(--accent); outline-offset: -.125rem; }
    .panel { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: auto; }
    .loading { height: 12rem; margin: 1rem; border-radius: .625rem; background: var(--sunk); }
    .empty { padding: 4rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .375rem; color: var(--mut); text-align: center; }
    .empty-title { color: var(--fg); font-weight: 500; }
  `,
})
export class ToolkitViewComponent {
  private readonly api = inject(FleetApiService);
  protected readonly tabs = TOOLKIT_TABS;
  protected readonly tabPanelId = 'toolkit-tabpanel';
  protected readonly activeTab = signal<ToolkitTab>('catalog');
  protected readonly activityTool = signal<string | undefined>(undefined);
  protected readonly load = signal<ToolsLoad>({ status: 'loading' });

  constructor() {
    void this.reload();
  }

  protected showActivityOf(toolName: string): void {
    this.activityTool.set(toolName);
    this.activeTab.set('activity');
  }

  protected tools(): readonly ToolSummary[] | undefined {
    const load = this.load();
    return load.status === 'loaded' ? load.tools : undefined;
  }

  protected async reload(): Promise<void> {
    this.load.set({ status: 'loading' });
    try {
      this.load.set({ status: 'loaded', tools: await this.api.listTools() });
    } catch {
      this.load.set({ status: 'failed' });
    }
  }

  protected onTabKeydown(event: KeyboardEvent): void {
    const currentIndex = TOOLKIT_TABS.findIndex((tab) => tab.key === this.activeTab());
    const targetIndex = nextTabIndex(event, { currentIndex, tabCount: TOOLKIT_TABS.length, orientation: 'horizontal' });
    if (targetIndex === undefined) return;
    event.preventDefault();
    this.activeTab.set(TOOLKIT_TABS[targetIndex].key);
    focusTabAt(event.currentTarget as HTMLElement, targetIndex);
  }
}
