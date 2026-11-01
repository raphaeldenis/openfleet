import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FleetApiService } from '../core/fleet-api.service';
import { BannerComponent } from '../design/banner.component';
import { dailyTotalsOf, usageRangeOf, type DayTotals, type UsageRange } from './usage-days';

type UsageLoad = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; days: DayTotals[] };

const RANGES: ReadonlyArray<{ range: UsageRange; label: string }> = [
  { range: 'today', label: 'Today' },
  { range: 'last7Days', label: '7 days' },
  { range: 'last30Days', label: '30 days' },
];

const NO_COST = 'n/a';
const formatCount = (count: number): string => count.toLocaleString('en-US');
const formatCost = (costUsd: number | null): string => (costUsd === null ? NO_COST : `$${costUsd.toFixed(2)}`);

/** The tokens and cost the usage ledger holds per UTC day, optionally split by model. */
@Component({
  selector: 'of-usage-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent],
  template: `
    <section class="usage" data-testid="usage-view">
      <header class="head">
        <h1>Usage</h1>
        <label class="by-model"><input type="checkbox" [checked]="splitByModel()" (change)="splitByModel.set(!splitByModel())" /> By model</label>
        @for (option of ranges; track option.range) {
          <button type="button" class="range" [attr.aria-pressed]="range() === option.range" (click)="pick(option.range)">{{ option.label }}</button>
        }
      </header>

      @switch (load().status) {
        @case ('loading') {
          <div class="loading" data-testid="usage-loading" role="status" aria-label="Loading usage"></div>
        }
        @case ('failed') {
          <of-banner data-testid="usage-error" variant="error" glyph="✕" title="Usage unavailable" description="The daemon could not read the usage ledger.">
            <button type="button" class="of-btn of-btn--compact" (click)="reload()">Retry</button>
          </of-banner>
        }
      }

      @if (days(); as shownDays) {
        @if (shownDays.length === 0) {
          <div class="empty" data-testid="usage-empty">
            <span class="empty-title">No usage yet</span>
            <span>Spend and tokens appear here once a session ends a turn. Usage ingestion is off by default: start the daemon with OPENFLEET_USAGE_INGESTION=1 to record it.</span>
          </div>
        } @else {
          <div class="ledger-scroll" tabindex="0" role="region" aria-label="Daily usage table">
          <table class="ledger">
            <thead>
              <tr><th scope="col">Day (UTC)</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Cache read</th><th scope="col" class="num">Cache write</th><th scope="col" class="num">Cost</th></tr>
            </thead>
            <tbody>
              @for (day of shownDays; track day.dayUtc) {
                <tr class="day" [attr.data-testid]="'usage-day-' + day.dayUtc">
                  <th scope="row">{{ day.dayUtc }}</th>
                  <td class="num">{{ count(day.inputTokens) }}</td><td class="num">{{ count(day.outputTokens) }}</td>
                  <td class="num">{{ count(day.cacheReadInputTokens) }}</td><td class="num">{{ count(day.cacheCreationInputTokens) }}</td>
                  <td class="num">{{ cost(day.costUsd) }}</td>
                </tr>
                @if (splitByModel()) {
                  @for (model of day.byModel; track model.model) {
                    <tr class="model" [attr.data-testid]="'usage-model-' + day.dayUtc + '-' + model.model">
                      <th scope="row">{{ model.model }}</th>
                      <td class="num">{{ count(model.inputTokens) }}</td><td class="num">{{ count(model.outputTokens) }}</td>
                      <td class="num">{{ count(model.cacheReadInputTokens) }}</td><td class="num">{{ count(model.cacheCreationInputTokens) }}</td>
                      <td class="num">{{ cost(model.costUsd) }}</td>
                    </tr>
                  }
                }
              }
            </tbody>
          </table>
          </div>
        }
      }
    </section>
  `,
  styles: `
    .usage { flex: 1; min-width: 0; max-width: 60rem; margin: 0 auto; padding: 1.25rem 1.5rem 3rem; display: flex; flex-direction: column; gap: 1rem; }
    @media (max-width: 75rem) { .usage { margin: 0; max-width: calc(100vw - 17.5rem); } }
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    h1 { flex: 1 1 auto; margin: 0; font-size: 1.25rem; font-weight: 600; }
    .by-model { font-size: .75rem; color: var(--mut); margin-right: .5rem; }
    .range { height: 1.625rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--panel); color: var(--fg); font-size: .75rem; cursor: pointer; }
    .range[aria-pressed='true'] { background: var(--active); }
    .loading { height: 12rem; border-radius: .625rem; background: var(--sunk); }
    .empty { padding: 4rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .375rem; color: var(--mut); text-align: center; }
    .empty-title { color: var(--fg); font-weight: 500; }
    .ledger-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .ledger { width: 100%; border-collapse: collapse; font-size: .75rem; }
    .ledger th[scope='row'] { position: sticky; left: 0; background: var(--panel); white-space: nowrap; }
    th, td { padding: .5rem 1rem; border-bottom: 1px solid var(--line); text-align: left; font-weight: 400; white-space: nowrap; }
    thead th { color: var(--mut); font-size: .6875rem; }
    .num { text-align: right; font-family: var(--mono); }
    .day th { font-family: var(--mono); font-weight: 500; }
    .model th { padding-left: 2rem; color: var(--mut); }
    .model td { color: var(--mut); }
  `,
})
export class UsageViewComponent {
  private readonly api = inject(FleetApiService);
  protected readonly ranges = RANGES;
  protected readonly range = signal<UsageRange>('last7Days');
  protected readonly splitByModel = signal(false);
  protected readonly load = signal<UsageLoad>({ status: 'loading' });
  protected readonly days = computed(() => {
    const load = this.load();
    return load.status === 'loaded' ? load.days : undefined;
  });
  protected readonly count = formatCount;
  protected readonly cost = formatCost;

  constructor() {
    void this.reload();
  }

  protected pick(range: UsageRange): void {
    this.range.set(range);
    void this.reload();
  }

  protected async reload(): Promise<void> {
    const requestedRange = this.range();
    this.load.set({ status: 'loading' });
    try {
      const rows = await this.api.getDailyUsage(usageRangeOf(requestedRange, new Date()));
      const isStale = requestedRange !== this.range();
      if (!isStale) this.load.set({ status: 'loaded', days: dailyTotalsOf(rows) });
    } catch {
      const isStale = requestedRange !== this.range();
      if (!isStale) this.load.set({ status: 'failed' });
    }
  }
}
