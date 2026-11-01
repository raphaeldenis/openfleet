import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ActivityRow } from '@openfleet/shared';
import { RouterLink } from '@angular/router';
import { FILE_DOWNLOAD } from '../core/file-download';
import { FleetApiService } from '../core/fleet-api.service';
import { BannerComponent } from '../design/banner.component';
import { activityAsCsv, activityAsJson } from './audit-export';
import {
  AUDIT_ACTORS, AUDIT_OUTCOMES, AUDIT_PERIODS, DEFAULT_AUDIT_FILTERS, activityQueryOf, choiceOf, hasNonDefaultFilter, periodOf, type AuditFilters,
} from './audit-filters';
import { detailFieldsOf, entityNameOf, inertText, linkableSessionIdOf, utcTimeOf } from './audit-row-text';

type AuditLoad = 'loading' | 'failed' | 'loaded';
type MoreLoad = 'idle' | 'loading' | 'failed';
type ExportLoad = 'idle' | 'running' | 'failed';
type ExportFormat = 'csv' | 'json';

const MAX_EXPORTED_ROWS = 10_000;

const EXPORT_FORMATS: Record<ExportFormat, { mimeType: string; serialize: (rows: readonly ActivityRow[]) => string }> = {
  csv: { mimeType: 'text/csv', serialize: activityAsCsv },
  json: { mimeType: 'application/json', serialize: activityAsJson },
};

/** Every mutating action of the fleet, newest first, narrowed by actor, outcome, action and period; each row opens into its full record. */
@Component({
  selector: 'of-audit-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, RouterLink],
  template: `
    <section class="audit" data-testid="audit-view">
      <header class="head">
        <h1>Audit</h1>
        <span class="subtitle">every mutating action</span>
      </header>

      <div class="filters" role="group" aria-label="Filters">
        <label>Actor
          <select #actor (change)="pickActor(actor.value)">
            <option value="" [selected]="filters().actor === ''">All actors</option>
            @for (kind of actors; track kind) {
              <option [value]="kind" [selected]="filters().actor === kind">{{ kind }}</option>
            }
          </select>
        </label>
        <label>Outcome
          <select #outcome (change)="pickOutcome(outcome.value)">
            <option value="" [selected]="filters().outcome === ''">All outcomes</option>
            @for (result of outcomes; track result) {
              <option [value]="result" [selected]="filters().outcome === result">{{ result }}</option>
            }
          </select>
        </label>
        <label>Action
          <input #action type="text" placeholder="e.g. create_note" autocomplete="off" spellcheck="false" [value]="filters().action" (change)="commitAction(action.value)" (keydown.enter)="commitAction(action.value)" />
        </label>
        <label>Period
          <select #period (change)="pickPeriod(period.value)">
            @for (option of periods; track option.period) {
              <option [value]="option.period" [selected]="filters().period === option.period">{{ option.label }}</option>
            }
          </select>
        </label>
      </div>

      @switch (load()) {
        @case ('loading') {
          <div class="loading" data-testid="audit-loading" role="status" aria-label="Loading the audit log"></div>
        }
        @case ('failed') {
          <of-banner data-testid="audit-error" variant="error" glyph="✕" title="Audit log unavailable" description="The daemon could not read the activity log.">
            <button type="button" class="of-btn of-btn--compact" (click)="reload()">Retry</button>
          </of-banner>
        }
        @case ('loaded') {
          @if (rows().length === 0) {
            <div class="empty" data-testid="audit-empty">
              <span class="empty-title">No actions match</span>
              <span>Widen the period or clear a filter.</span>
              @if (isFiltered()) {
                <button type="button" class="of-btn of-btn--compact" (click)="resetFilters()">Reset filters</button>
              }
            </div>
          } @else {
            <div class="export" role="group" aria-label="Export the current filter">
              <button type="button" class="of-btn of-btn--compact" [disabled]="exportLoad() === 'running'" (click)="exportAs('csv')">Export CSV</button>
              <button type="button" class="of-btn of-btn--compact" [disabled]="exportLoad() === 'running'" (click)="exportAs('json')">Export JSON</button>
              @if (exportLoad() === 'running') {
                <span class="export-note" role="status">Preparing the file…</span>
              }
            </div>
            @if (exportLoad() === 'failed') {
              <of-banner data-testid="audit-export-error" variant="error" glyph="✕" title="Export failed" description="The log could not be read to the end, so no file was saved." />
            }
            <div class="table-scroll" tabindex="0" role="region" aria-label="Audit log table">
              <table class="log">
                <thead>
                  <tr><th scope="col">Time (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Outcome</th><th scope="col"><span class="visually-hidden">Details</span></th></tr>
                </thead>
                <tbody>
                  @for (row of rows(); track row.id) {
                    <tr class="entry" [attr.data-testid]="'audit-row-' + row.id">
                      <td class="time">{{ time(row) }}</td>
                      <td><span class="kind" [attr.data-kind]="row.actorKind">{{ row.actorKind }}</span> {{ text(row.actorLabel) }}</td>
                      <td class="action">{{ text(row.action) }}</td>
                      <td>@if (row.entityKind) {<span class="entity-kind">{{ text(row.entityKind) }}</span> }{{ entityName(row) }}</td>
                      <td class="outcome" [attr.data-outcome]="row.outcome">{{ row.outcome }}</td>
                      <td class="row-actions">
                        @if (sessionIdOf(row); as sessionId) {
                          <a class="session-link" [routerLink]="['/session', sessionId]" [attr.aria-label]="'Open session of ' + row.action">Session</a>
                        }
                        <button type="button" class="of-btn of-btn--compact" [attr.aria-expanded]="isOpen(row)" [attr.aria-controls]="'audit-detail-' + row.id" [attr.aria-label]="'Details of ' + row.action" (click)="toggleDetail(row)">{{ isOpen(row) ? 'Hide' : 'Details' }}</button>
                      </td>
                    </tr>
                    @if (isOpen(row)) {
                      <tr class="detail" [id]="'audit-detail-' + row.id" [attr.data-testid]="'audit-detail-' + row.id">
                        <td colspan="6">
                          <dl>
                            @for (field of fieldsOf(row); track field.label) {
                              <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
                            }
                          </dl>
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>

            @if (moreLoad() === 'failed') {
              <of-banner data-testid="audit-more-error" variant="error" glyph="✕" title="Could not load more" description="The rows above are kept.">
                <button type="button" class="of-btn of-btn--compact" (click)="loadMore()">Retry</button>
              </of-banner>
            } @else if (nextCursor()) {
              <button type="button" class="of-btn more" [disabled]="moreLoad() === 'loading'" (click)="loadMore()">Load more</button>
            }
          }
        }
      }
    </section>
  `,
  styles: `
    .audit { flex: 1; min-width: 0; padding: 1.25rem 1.5rem 3rem; display: flex; flex-direction: column; gap: 1rem; }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem; }
    h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
    .subtitle { font-size: .75rem; color: var(--mut); }
    .filters { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
    .filters label { display: flex; align-items: center; gap: .375rem; font-size: .75rem; color: var(--mut); }
    .filters select, .filters input { height: 1.625rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--panel); color: var(--fg); font-size: .75rem; }
    .filters input { width: 11rem; }
    .loading { height: 12rem; border-radius: .625rem; background: var(--sunk); }
    .empty { padding: 4rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .375rem; color: var(--mut); text-align: center; }
    .empty-title { color: var(--fg); font-weight: 500; }
    .table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .log { width: 100%; border-collapse: collapse; font-size: .75rem; }
    th, td { padding: .5rem .75rem; border-bottom: 1px solid var(--line); text-align: left; font-weight: 400; white-space: nowrap; }
    thead th { color: var(--mut); font-size: .6875rem; font-weight: 600; }
    .time, .action { font-family: var(--mono); }
    .kind, .entity-kind { padding: 0 .25rem; border-radius: .1875rem; background: var(--sunk); color: var(--mut); font-size: .6875rem; }
    .outcome[data-outcome='denied'], .outcome[data-outcome='error'] { color: var(--s-err); }
    .detail td { background: var(--sunk); white-space: normal; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
    dt { color: var(--mut); }
    dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
    .export { display: flex; align-items: center; gap: .5rem; }
    .export-note { font-size: .75rem; color: var(--mut); }
    .row-actions { display: flex; align-items: center; gap: .5rem; }
    .session-link { color: var(--acc); font-size: .6875rem; }
    .more { align-self: center; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `,
})
export class AuditViewComponent {
  private readonly api = inject(FleetApiService);
  protected readonly actors = AUDIT_ACTORS;
  protected readonly outcomes = AUDIT_OUTCOMES;
  protected readonly periods = AUDIT_PERIODS;
  protected readonly filters = signal<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  protected readonly rows = signal<ActivityRow[]>([]);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  protected readonly load = signal<AuditLoad>('loading');
  protected readonly moreLoad = signal<MoreLoad>('idle');
  protected readonly openRowId = signal<number | null>(null);
  protected readonly exportLoad = signal<ExportLoad>('idle');
  private readonly saveFile = inject(FILE_DOWNLOAD);
  protected readonly sessionIdOf = linkableSessionIdOf;
  protected readonly text = inertText;
  protected readonly time = utcTimeOf;
  protected readonly entityName = entityNameOf;
  protected readonly fieldsOf = detailFieldsOf;
  private latestRequest = 0;

  constructor() {
    void this.reload();
  }

  protected isFiltered(): boolean {
    return hasNonDefaultFilter(this.filters());
  }

  protected isOpen(row: ActivityRow): boolean {
    return this.openRowId() === row.id;
  }

  protected toggleDetail(row: ActivityRow): void {
    this.openRowId.set(this.isOpen(row) ? null : row.id);
  }

  protected pickActor(value: string): void {
    this.changeFilters({ actor: choiceOf(AUDIT_ACTORS, value) });
  }

  protected pickOutcome(value: string): void {
    this.changeFilters({ outcome: choiceOf(AUDIT_OUTCOMES, value) });
  }

  protected pickPeriod(value: string): void {
    this.changeFilters({ period: periodOf(value) });
  }

  protected commitAction(value: string): void {
    this.changeFilters({ action: value.trim() });
  }

  protected resetFilters(): void {
    this.changeFilters(DEFAULT_AUDIT_FILTERS);
  }

  private changeFilters(change: Partial<AuditFilters>): void {
    const next = { ...this.filters(), ...change };
    const isUnchanged = (Object.keys(next) as Array<keyof AuditFilters>).every((key) => next[key] === this.filters()[key]);
    if (isUnchanged) return;
    this.filters.set(next);
    void this.reload();
  }

  protected async reload(): Promise<void> {
    const request = ++this.latestRequest;
    this.load.set('loading');
    this.moreLoad.set('idle');
    this.openRowId.set(null);
    try {
      const page = await this.api.listActivity(activityQueryOf({ filters: this.filters(), now: new Date() }));
      if (request !== this.latestRequest) return;
      this.rows.set(page.items);
      this.nextCursor.set(page.nextCursor);
      this.load.set('loaded');
    } catch {
      if (request === this.latestRequest) this.load.set('failed');
    }
  }

  protected async exportAs(format: ExportFormat): Promise<void> {
    if (this.exportLoad() === 'running') return;
    const request = this.latestRequest;
    const now = new Date();
    this.exportLoad.set('running');
    try {
      const exported = await this.readEveryPage({ filters: this.filters(), now });
      if (request !== this.latestRequest) return this.exportLoad.set('idle');
      const { mimeType, serialize } = EXPORT_FORMATS[format];
      this.saveFile({ filename: `openfleet-audit-${now.toISOString().slice(0, 10)}.${format}`, mimeType, content: serialize(exported) });
      this.exportLoad.set('idle');
    } catch {
      this.exportLoad.set('failed');
    }
  }

  private async readEveryPage({ filters, now }: { filters: AuditFilters; now: Date }): Promise<ActivityRow[]> {
    const exported: ActivityRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.listActivity(activityQueryOf({ filters, now, cursor }));
      exported.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined && exported.length < MAX_EXPORTED_ROWS);
    return exported;
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor === undefined || this.moreLoad() === 'loading') return;
    const request = this.latestRequest;
    this.moreLoad.set('loading');
    try {
      const page = await this.api.listActivity(activityQueryOf({ filters: this.filters(), now: new Date(), cursor }));
      if (request !== this.latestRequest) return;
      this.rows.update((shown) => [...shown, ...page.items]);
      this.nextCursor.set(page.nextCursor);
      this.moreLoad.set('idle');
    } catch {
      if (request === this.latestRequest) this.moreLoad.set('failed');
    }
  }
}
