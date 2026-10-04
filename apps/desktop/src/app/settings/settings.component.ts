import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, InjectionToken, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { environment } from '../../environments/environment';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { SupportActions } from '../core/support-actions';
import { VersionsService } from '../core/versions.service';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';
import { DiagnosticsSettingsComponent } from './diagnostics-settings.component';

type SettingsTab = 'models' | 'daemon' | 'diagnostics' | 'about';

const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'models', label: 'Models' },
  { key: 'daemon', label: 'Daemon' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'about', label: 'About' },
];

const MODEL_RUNGS: ReadonlyArray<{ rung: string; description: string }> = [
  { rung: 'haiku', description: 'Cheapest rung' },
  { rung: 'sonnet', description: 'Default for workers' },
  { rung: 'opus', description: 'Default for managers' },
  { rung: 'fable', description: 'Experimental rung' },
];

/** How long a dropdown must stay untouched before its chosen model is sent to the daemon. */
export const MODEL_SETTLE_MS = new InjectionToken<number>('MODEL_SETTLE_MS', { providedIn: 'root', factory: () => 600 });

interface ModelChange {
  rung: string;
  modelId: string;
}

type ModelSaveState =
  | { kind: 'idle' }
  | { kind: 'pending'; change: ModelChange }
  | { kind: 'saving'; change: ModelChange }
  | { kind: 'saved'; rung: string }
  | { kind: 'failed'; change: ModelChange; cause: string };

type SupportAction = 'logs' | 'issue';

const SUPPORT_UNAVAILABLE_TOOLTIP = 'Available in the OpenFleet desktop app';

const SUPPORT_FAILURES: Record<SupportAction, string> = {
  logs: '✕ Couldn’t open the logs folder.',
  issue: '✕ Couldn’t open the issue form.',
};

const GENERIC_SAVE_FAILURE = 'Something went wrong. Your change was not applied.';

function describeSaveFailure(failure: unknown): string {
  if (!(failure instanceof ApiError)) return GENERIC_SAVE_FAILURE;
  const isConfigReadOnly = failure.status === 409 && failure.code === 'config_read_only';
  if (isConfigReadOnly) return 'config.json is read-only. Your change was not applied.';
  const isConfigUnreadable = failure.status === 409 && failure.code === 'config_unreadable';
  if (isConfigUnreadable) return 'config.json couldn’t be read. Your change was not applied.';
  const isModelIdRefused = failure.status === 400;
  if (isModelIdRefused) return 'The daemon rejected this model id.';
  return GENERIC_SAVE_FAILURE;
}

function isModelTable(body: unknown): body is Record<string, string> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function isAvailableModels(body: unknown): body is { models: string[] } {
  return typeof body === 'object' && body !== null && 'models' in body && Array.isArray(body.models);
}

@Component({
  selector: 'of-settings',
  imports: [DiagnosticsSettingsComponent],
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
                      [attr.data-rung]="row.rung"
                      [attr.aria-label]="row.rung + ' model'"
                      [attr.aria-disabled]="isSavingModel() ? 'true' : null"
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
              <p class="hint status" role="status" data-testid="models-save-status">{{ saveStatusMessage() }}</p>
              @if (saveState(); as state) {
                @if (state.kind === 'failed') {
                  <div class="error-card" role="alert" data-testid="models-save-error">
                    <div class="error-text">
                      <span class="error-title">✕ Couldn’t save {{ state.change.rung }}</span>
                      <span class="detail">{{ state.cause }}</span>
                    </div>
                    <button type="button" class="of-btn of-btn--secondary" (click)="retryFailedSave(state.change)">Retry</button>
                  </div>
                }
              }
              <p class="hint" data-testid="models-edit-hint">A change applies to new sessions · running sessions keep their model</p>
            } @else {
              <p class="detail" data-testid="models-loading">Loading…</p>
            }
          </section>
        } @else if (activeTab() === 'diagnostics') {
          <of-diagnostics-settings />
        } @else if (activeTab() === 'about') {
          <section class="panel" data-testid="settings-about">
            <h1>About</h1>
            <div class="rows">
              <div class="row">
                <div class="label"><span class="name">App version</span></div>
                <span class="value mono" data-testid="about-app-version">{{ versionLabelOf({ version: versions.appVersion(), isSettled: versions.isAppVersionSettled() }) }}</span>
              </div>
              <div class="row">
                <div class="label"><span class="name">Daemon version</span><span class="detail">Reported by the daemon on {{ daemonAddress }}</span></div>
                <span class="value mono" data-testid="about-daemon-version">{{ versionLabelOf({ version: versions.daemonVersion(), isSettled: versions.isDaemonVersionSettled() }) }}</span>
              </div>
              <div class="row">
                <div class="label"><span class="name">Support</span><span class="detail">Daemon logs stay on this Mac · a report is sent only if you submit it in your browser</span></div>
                <div class="actions">
                  <button type="button" class="of-btn of-btn--secondary" data-testid="about-reveal-logs" [disabled]="!support.isAvailable" [attr.title]="supportUnavailableTooltip()" (click)="runSupportAction('logs')">Reveal logs</button>
                  <button type="button" class="of-btn of-btn--secondary" data-testid="about-report-issue" [disabled]="!support.isAvailable" [attr.title]="supportUnavailableTooltip()" (click)="runSupportAction('issue')">Report an issue</button>
                </div>
              </div>
            </div>
            @if (supportError(); as message) {
              <p class="error" role="alert" data-testid="about-support-error">{{ message }}</p>
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
    select.value { field-sizing: content; color: var(--fg); cursor: pointer; }
    select.value[aria-disabled='true'] { cursor: progress; opacity: .6; }
    .status:empty { position: absolute; }
    select.value:focus-visible { outline: 2px solid var(--accent); outline-offset: .125rem; }
    .mono { font-family: var(--mono); }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); }
    .actions { display: flex; gap: .5rem; }
    .error { margin: 0; color: var(--state-error); }
    .error-card { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border: 1px solid var(--state-error); border-radius: .625rem; background: var(--panel); }
    .error-text { flex: 1; display: flex; flex-direction: column; }
    .error-title { color: var(--state-error); font-weight: 500; }
  `,
})
export class SettingsComponent {
  private readonly api = inject(FleetApiService);
  protected readonly versions = inject(VersionsService);
  protected readonly support = inject(SupportActions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly settleMs = inject(MODEL_SETTLE_MS);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly tabs = SETTINGS_TABS;
  protected readonly rungs = MODEL_RUNGS;
  protected readonly daemonAddress = environment.daemonAddress;
  protected readonly tabPanelId = 'settings-tabpanel';
  protected readonly isAdminTokenFound = environment.adminToken.trim() !== '';

  protected readonly activeTab = signal<SettingsTab>('models');
  protected readonly modelTable = signal<Record<string, string> | null>(null);
  protected readonly modelsFailed = signal(false);
  protected readonly availableModels = signal<string[]>([]);
  protected readonly supportError = signal<string | null>(null);
  protected readonly saveState = signal<ModelSaveState>({ kind: 'idle' });
  protected readonly isSavingModel = computed(() => this.saveState().kind === 'saving');

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

  // One persistent live region carries every progress and success notice, so a screen reader announces the
  // text change (a region inserted fresh between saves is easily never spoken).
  protected readonly saveStatusMessage = computed(() => {
    const state = this.saveState();
    if (state.kind === 'saving') return `Saving ${state.change.rung}…`;
    if (state.kind === 'pending') return `Unsaved change to ${state.change.rung} · saves once you stop choosing.`;
    if (state.kind === 'saved') return `✓ Saved ${state.rung}.`;
    return '';
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.savePendingChange());
    void this.versions.loadAppVersion();
    void this.loadModelTable();
    this.route?.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requestedTab = SETTINGS_TABS.find((tab) => tab.key === params.get('tab'));
      if (requestedTab) this.activeTab.set(requestedTab.key);
    });
  }

  // A native select fires `change` on every arrow step and type-ahead match, so only the id the user settles
  // on is sent. The dropdowns stay enabled while a save runs (a disabled select drops keyboard focus), so a
  // choice made during a save, or beside an unsaved change on another rung, is put back instead of kept.
  protected onModelChosen(rung: string, select: HTMLSelectElement): void {
    const savedId = this.modelTable()?.[rung] ?? '';
    const state = this.saveState();
    const isBlockedByAnotherChange = state.kind === 'saving' || (state.kind === 'pending' && state.change.rung !== rung);
    if (isBlockedByAnotherChange) {
      select.value = savedId;
      return;
    }
    clearTimeout(this.settleTimer);
    const isBackOnSavedId = select.value === savedId;
    if (isBackOnSavedId) {
      this.saveState.set({ kind: 'idle' });
      return;
    }
    this.saveState.set({ kind: 'pending', change: { rung, modelId: select.value } });
    this.settleTimer = setTimeout(() => this.savePendingChange(), this.settleMs);
  }

  protected retryFailedSave(change: ModelChange): void {
    this.showIdInDropdown(change.rung, change.modelId);
    void this.saveChange(change);
  }

  // Also the destroy hook: leaving the screen inside the settle window sends the change at once (the PUT is
  // idempotent), so it is never silently dropped.
  private savePendingChange(): void {
    clearTimeout(this.settleTimer);
    const state = this.saveState();
    if (state.kind === 'pending') void this.saveChange(state.change);
  }

  private async saveChange(change: ModelChange): Promise<void> {
    const { rung, modelId } = change;
    this.saveState.set({ kind: 'saving', change });
    try {
      const { models } = await this.api.saveModels({ [rung]: modelId });
      this.modelTable.set(models);
      this.saveState.set({ kind: 'saved', rung });
    } catch (failure) {
      this.showIdInDropdown(rung, this.modelTable()?.[rung] ?? '');
      this.saveState.set({ kind: 'failed', change, cause: describeSaveFailure(failure) });
    }
  }

  private showIdInDropdown(rung: string, modelId: string): void {
    const select = this.host.nativeElement.querySelector<HTMLSelectElement>(`select[data-rung="${rung}"]`);
    if (select) select.value = modelId;
  }

  protected supportUnavailableTooltip(): string | null {
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
