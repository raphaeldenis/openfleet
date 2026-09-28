import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { FleetApiService } from '../core/fleet-api.service';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';

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

type ModelSaveOutcome =
  | { kind: 'saved'; rung: string }
  | { kind: 'unknown'; rung: string; modelId: string }
  | { kind: 'failed'; rung: string };

function isModelTable(body: unknown): body is Record<string, string> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function isAvailableModels(body: unknown): body is { models: string[] } {
  return typeof body === 'object' && body !== null && 'models' in body && Array.isArray(body.models);
}

@Component({
  selector: 'of-settings',
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
        @if (activeTab() === 'models') {
          <section class="panel" data-testid="settings-models">
            <h1>Models</h1>
            @if (modelsFailed()) {
              <p class="error" role="alert" data-testid="models-error">✕ Couldn’t load the model table from the daemon.</p>
            } @else if (modelTable(); as table) {
              <div class="rows">
                @for (row of rungs; track row.rung) {
                  <div class="row" [attr.data-testid]="'model-row-' + row.rung">
                    <div class="label"><span class="name">{{ row.rung }}</span><span class="detail">{{ row.description }}</span></div>
                    <select
                      class="value mono"
                      [attr.data-testid]="'model-select-' + row.rung"
                      [attr.aria-label]="row.rung + ' model'"
                      [disabled]="isSavingModel()"
                      (change)="onModelChosen(row.rung, $any($event.target))"
                    >
                      @if (!table[row.rung]) {
                        <option value="" selected disabled>—</option>
                      }
                      @for (modelId of optionIdsByRung()[row.rung]; track modelId) {
                        <option [value]="modelId" [selected]="modelId === table[row.rung]">{{ modelId }}</option>
                      }
                    </select>
                  </div>
                }
              </div>
              @if (saveOutcome(); as outcome) {
                @if (outcome.kind === 'failed') {
                  <p class="error" role="alert" data-testid="models-save-error">✕ Couldn’t save the {{ outcome.rung }} model — the daemon kept the previous one.</p>
                } @else if (outcome.kind === 'unknown') {
                  <p class="hint" role="status" data-testid="models-save-status">✓ Saved {{ outcome.rung }} · {{ outcome.modelId }} is not in the known model list — saved anyway.</p>
                } @else {
                  <p class="hint" role="status" data-testid="models-save-status">✓ Saved {{ outcome.rung }}.</p>
                }
              }
              <p class="hint" data-testid="models-edit-hint">A change applies to new sessions · running sessions keep their model</p>
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
                <div class="label"><span class="name">Stored admin token</span><span class="detail">Whether this app holds one · the daemon may still refuse it</span></div>
                <span class="value mono" data-testid="admin-token-status">{{ isAdminTokenFound ? 'found' : 'not found' }}</span>
              </div>
            </div>
          </section>
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
    .panel { max-width: 40rem; display: flex; flex-direction: column; gap: 1rem; }
    h1 { margin: 0; font-size: 1.125rem; font-weight: 600; }
    .rows { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .row { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    .label { flex: 1; display: flex; flex-direction: column; }
    .name { font-weight: 500; }
    .detail { font-size: .75rem; color: var(--mut); }
    .value { height: 1.75rem; min-width: 8rem; display: inline-flex; align-items: center; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); font-size: .75rem; }
    select.value { color: var(--fg); cursor: pointer; }
    select.value:disabled { cursor: progress; opacity: .6; }
    select.value:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .mono { font-family: var(--mono); }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); }
    .error { margin: 0; color: var(--state-error); }
  `,
})
export class SettingsComponent {
  private readonly api = inject(FleetApiService);

  protected readonly tabs = SETTINGS_TABS;
  protected readonly rungs = MODEL_RUNGS;
  protected readonly daemonAddress = environment.daemonAddress;
  protected readonly tabPanelId = 'settings-tabpanel';
  protected readonly isAdminTokenFound = environment.adminToken.trim() !== '';

  protected readonly activeTab = signal<SettingsTab>('models');
  protected readonly modelTable = signal<Record<string, string> | null>(null);
  protected readonly modelsFailed = signal(false);
  protected readonly availableModels = signal<string[]>([]);
  protected readonly isSavingModel = signal(false);
  protected readonly saveOutcome = signal<ModelSaveOutcome | null>(null);

  // Each rung offers every available model, plus its current id when the daemon does not list it, so a
  // custom id stays selectable instead of blanking the dropdown.
  protected readonly optionIdsByRung = computed(() => {
    const available = this.availableModels();
    const table = this.modelTable() ?? {};
    return Object.fromEntries(
      MODEL_RUNGS.map(({ rung }) => {
        const currentId = table[rung];
        const currentIdIsMissing = !!currentId && !available.includes(currentId);
        return [rung, currentIdIsMissing ? [...available, currentId] : available];
      }),
    );
  });

  constructor() {
    void this.loadModelTable();
  }

  protected async onModelChosen(rung: string, select: HTMLSelectElement): Promise<void> {
    const previousId = this.modelTable()?.[rung] ?? '';
    const chosenId = select.value;
    if (chosenId === previousId) return;
    this.isSavingModel.set(true);
    try {
      const { models, unknownRungs } = await this.api.saveModels({ [rung]: chosenId });
      this.modelTable.set(models);
      this.saveOutcome.set(unknownRungs.includes(rung) ? { kind: 'unknown', rung, modelId: chosenId } : { kind: 'saved', rung });
    } catch {
      select.value = previousId;
      this.saveOutcome.set({ kind: 'failed', rung });
    } finally {
      this.isSavingModel.set(false);
    }
  }

  protected onTabKeydown(event: KeyboardEvent): void {
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.key === this.activeTab());
    const targetIndex = nextTabIndex(event, { currentIndex, tabCount: SETTINGS_TABS.length, orientation: 'vertical' });
    if (targetIndex === undefined) return;
    event.preventDefault();
    this.activeTab.set(SETTINGS_TABS[targetIndex].key);
    focusTabAt(event.currentTarget as HTMLElement, targetIndex);
  }

  private async loadModelTable(): Promise<void> {
    const [tableResult, availableResult] = await Promise.allSettled([this.api.models(), this.api.availableModels()]);
    if (availableResult.status === 'fulfilled' && isAvailableModels(availableResult.value)) this.availableModels.set(availableResult.value.models);
    const table: unknown = tableResult.status === 'fulfilled' ? tableResult.value : undefined;
    if (isModelTable(table)) this.modelTable.set(table);
    else this.modelsFailed.set(true);
  }
}
