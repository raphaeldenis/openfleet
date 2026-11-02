import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { ActivityRow } from '@openfleet/shared';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { clockTimeOf } from '../core/clock-time';
import { ToolkitActivityClient, type ToolkitActivityRequest } from '../core/toolkit-activity-client';
import { BannerComponent } from '../design/banner.component';

type OutcomeFilter = 'all' | 'error' | 'denied';
type ActivityLoad = 'loading' | 'failed' | 'loaded';
type MoreLoad = 'idle' | 'loading' | 'failed';

const OUTCOME_FILTERS: ReadonlyArray<{ key: OutcomeFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'error', label: 'Errors only' },
  { key: 'denied', label: 'Denied' },
];

const NO_DURATION = '—';

/** The MCP tool calls the activity log holds, newest first, with the marks of the log shown as they are. */
@Component({
  selector: 'of-toolkit-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent],
  template: `
    <div class="activity">
      <div class="filters">
        @for (filter of outcomeFilters; track filter.key) {
          <button type="button" class="chip" [attr.aria-pressed]="outcome() === filter.key" (click)="outcome.set(filter.key)">{{ filter.label }}</button>
        }
        @if (tool(); as filteredTool) {
          <button type="button" class="chip tool-chip" [attr.aria-label]="'Clear tool filter ' + filteredTool" (click)="toolCleared.emit()">{{ filteredTool }} ✕</button>
        }
      </div>

      @switch (load()) {
        @case ('loading') {
          <div class="loading" data-testid="toolkit-activity-loading" role="status" aria-label="Loading activity"></div>
        }
        @case ('failed') {
          <of-banner data-testid="toolkit-activity-error" variant="error" glyph="✕" title="Activity unavailable" description="The daemon could not read the activity log.">
            <button type="button" class="of-btn of-btn--compact" (click)="reload()">Retry</button>
          </of-banner>
        }
        @case ('loaded') {
          @if (rows().length === 0) {
            <div class="empty" data-testid="toolkit-activity-empty">
              <span class="empty-title">No calls recorded</span>
              <span>Calls that change something appear here once an agent makes them.</span>
            </div>
          } @else {
            <div class="table-scroll" tabindex="0" role="region" aria-label="MCP tool calls">
              <table class="calls">
                <thead>
                  <tr><th scope="col">Time</th><th scope="col">Caller</th><th scope="col">Tool</th><th scope="col">Arguments → result</th><th scope="col">Status</th><th scope="col" class="num">Took</th></tr>
                </thead>
                <tbody>
                  @for (call of rows(); track call.id) {
                    <tr [attr.data-testid]="'toolkit-activity-row-' + call.id">
                      <td class="mono mut">{{ timeOf(call) }}</td>
                      <td>{{ safe(call.actorLabel) }}</td>
                      <td class="mono">{{ safe(call.action) }}</td>
                      <td class="excerpts">
                        <span class="mono mut">{{ safe(call.argsExcerpt ?? '') }}</span>
                        @if (call.resultExcerpt; as result) { <span class="mono" [class.bad]="call.outcome !== 'ok'">→ {{ safe(result) }}</span> }
                      </td>
                      <td><span class="status" [attr.data-outcome]="call.outcome">{{ call.outcome }}</span></td>
                      <td class="num mono mut">{{ durationOf(call) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (moreLoad() === 'failed') {
              <p class="more-error" data-testid="toolkit-activity-more-error" role="alert">Could not load more calls.</p>
            }
            @if (nextCursor()) {
              <button type="button" class="of-btn of-btn--compact more" [disabled]="moreLoad() === 'loading'" (click)="loadMore()">Load more</button>
            }
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .activity { display: flex; flex-direction: column; gap: .75rem; padding: .75rem 1rem; }
    .filters { display: flex; flex-wrap: wrap; gap: .5rem; }
    .chip { height: 1.5rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .75rem; background: var(--panel); color: var(--fg); font-size: .6875rem; cursor: pointer; white-space: nowrap; }
    .chip[aria-pressed='true'] { background: var(--active); }
    .tool-chip { font-family: var(--mono); }
    .chip:focus-visible { outline: .125rem solid var(--accent); outline-offset: .0625rem; }
    .loading { height: 12rem; border-radius: .625rem; background: var(--sunk); }
    .empty { padding: 4rem 1rem; display: flex; flex-direction: column; align-items: center; gap: .375rem; color: var(--mut); text-align: center; }
    .empty-title { color: var(--fg); font-weight: 500; }
    .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); }
    .calls { width: 100%; min-width: 52rem; border-collapse: collapse; font-size: .75rem; }
    th, td { padding: .4375rem .75rem; border-bottom: 1px solid var(--line); text-align: left; font-weight: 400; vertical-align: middle; }
    thead th { background: var(--sunk); color: var(--mut); font-size: .6875rem; font-weight: 600; white-space: nowrap; }
    .mono { font-family: var(--mono); }
    .mut { color: var(--mut); }
    .num { text-align: right; white-space: nowrap; }
    .excerpts { max-width: 28rem; }
    .excerpts span { display: block; font-size: .6875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bad { color: var(--state-error); }
    .status { font-family: var(--mono); font-size: .625rem; padding: .0625rem .375rem; border: 1px solid var(--line-2); border-radius: .25rem; }
    .status[data-outcome='error'], .status[data-outcome='denied'] { color: var(--state-error); border-color: var(--state-error); }
    .more { align-self: flex-start; }
    .more-error { margin: 0; font-size: .75rem; color: var(--state-error); }
  `,
})
export class ToolkitActivityComponent {
  private readonly client = inject(ToolkitActivityClient);
  readonly tool = input<string | undefined>(undefined);
  readonly toolCleared = output<void>();

  protected readonly outcomeFilters = OUTCOME_FILTERS;
  protected readonly outcome = signal<OutcomeFilter>('all');
  protected readonly load = signal<ActivityLoad>('loading');
  protected readonly moreLoad = signal<MoreLoad>('idle');
  protected readonly rows = signal<readonly ActivityRow[]>([]);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  protected readonly safe = showInvisibleControlsAsEscapes;

  private latestRequest = 0;

  constructor() {
    effect(() => {
      this.tool();
      this.outcome();
      untracked(() => void this.reload());
    });
  }

  protected timeOf(call: ActivityRow): string {
    return clockTimeOf(call.at);
  }

  protected durationOf(call: ActivityRow): string {
    return call.durationMs === undefined ? NO_DURATION : `${call.durationMs} ms`;
  }

  protected async reload(): Promise<void> {
    const request = this.requestForFirstPage();
    const requestNumber = ++this.latestRequest;
    this.load.set('loading');
    this.moreLoad.set('idle');
    try {
      const page = await this.client.readPage(request);
      if (requestNumber !== this.latestRequest) return;
      this.rows.set(page.items);
      this.nextCursor.set(page.nextCursor);
      this.load.set('loaded');
    } catch {
      if (requestNumber === this.latestRequest) this.load.set('failed');
    }
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor === undefined) return;
    const requestNumber = ++this.latestRequest;
    this.moreLoad.set('loading');
    try {
      const page = await this.client.readPage({ ...this.requestForFirstPage(), cursor });
      if (requestNumber !== this.latestRequest) return;
      this.rows.update((shown) => [...shown, ...page.items]);
      this.nextCursor.set(page.nextCursor);
      this.moreLoad.set('idle');
    } catch {
      if (requestNumber === this.latestRequest) this.moreLoad.set('failed');
    }
  }

  private requestForFirstPage(): ToolkitActivityRequest {
    const outcome = this.outcome();
    const tool = this.tool();
    return { ...(outcome === 'all' ? {} : { outcome }), ...(tool === undefined ? {} : { tool }) };
  }
}
