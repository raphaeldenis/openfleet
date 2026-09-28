import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { decideApproval } from '../core/decide-approval';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { KindBadgeComponent } from '../design/kind-badge.component';

type InboxTab = 'gates' | 'questions' | 'proposals';
type FilterKey = 'all' | 'unread' | 'mine' | 'blocked' | 'recent';

interface FilterOption {
  readonly key: FilterKey;
  readonly label: string;
  readonly disabled: boolean;
}

const NEEDS_BACKEND_SUPPORT = 'needs backend support';

// Only "All" runs against real data (the backend has no read-tracking, assignee or blocking
// flag on Approval yet) — the rest stay visible but inert rather than faking client-side heuristics.
const FILTERS: readonly FilterOption[] = [
  { key: 'all', label: 'All', disabled: false },
  { key: 'unread', label: 'Unread', disabled: true },
  { key: 'mine', label: 'Mine', disabled: true },
  { key: 'blocked', label: 'Blocked', disabled: true },
  { key: 'recent', label: 'Recent', disabled: true },
];

const TABS: readonly { readonly key: InboxTab; readonly label: string }[] = [
  { key: 'gates', label: 'Gates' },
  { key: 'questions', label: 'Questions from agents' },
  { key: 'proposals', label: 'Governance proposals' },
];

const LAST_TAB_INDEX = TABS.length - 1;

function tabIndexAfterKey(key: string, currentIndex: number): number | undefined {
  switch (key) {
    case 'ArrowRight': return currentIndex === LAST_TAB_INDEX ? 0 : currentIndex + 1;
    case 'ArrowLeft': return currentIndex === 0 ? LAST_TAB_INDEX : currentIndex - 1;
    case 'Home': return 0;
    case 'End': return LAST_TAB_INDEX;
    default: return undefined;
  }
}

@Component({
  selector: 'of-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KindBadgeComponent],
  template: `
    <section class="inbox" data-testid="inbox">
      <header class="title-row" data-testid="inbox-title-row">
        <h1 class="title">Inbox @if (events.approvals().length; as pendingCount) {<span class="count" data-testid="inbox-count">{{ pendingCount }}</span>}</h1>
        @if (tab() === 'gates') {
          <div class="filters" data-testid="inbox-filters">
            @for (filter of filters; track filter.key) {
              <button
                type="button"
                class="filter-chip"
                [class.active]="filter.key === 'all'"
                [disabled]="filter.disabled"
                [title]="filter.disabled ? needsBackendSupport : null"
                [attr.data-testid]="'inbox-filter-' + filter.key"
              >{{ filter.label }}</button>
            }
          </div>
        }
      </header>
      <nav class="tabs" role="tablist" aria-label="Inbox sections" (keydown)="onTabKeydown($event)">
        @for (entry of tabs; track entry.key) {
          <button
            type="button"
            role="tab"
            class="tab"
            [class.active]="tab() === entry.key"
            [id]="'inbox-tab-' + entry.key"
            [attr.aria-selected]="tab() === entry.key"
            [attr.aria-controls]="tabPanelId"
            [attr.tabindex]="tab() === entry.key ? 0 : -1"
            [attr.data-testid]="'inbox-tab-' + entry.key"
            (click)="tab.set(entry.key)"
          >{{ entry.label }}</button>
        }
      </nav>

      <div class="tabpanel" role="tabpanel" [id]="tabPanelId" [attr.aria-labelledby]="'inbox-tab-' + tab()">
      @switch (tab()) {
        @case ('gates') {
          <div class="gate-list" data-testid="inbox-gate-list">
            @for (item of items(); track item.id) {
              <article class="gate-card" data-testid="inbox-gate-card">
                <span class="avatar" data-testid="inbox-gate-avatar">{{ item.sessionEmoji }}</span>
                <div class="gate-body">
                  <div class="gate-meta" data-testid="inbox-gate-meta">
                    <of-kind-badge kind="gate" />
                    <span class="session-label" data-testid="inbox-gate-session">{{ item.sessionName }}</span>
                    <span class="age" data-testid="inbox-gate-age">{{ item.ageLabel }}</span>
                  </div>
                  <p class="gate-sentence" data-testid="inbox-gate-sentence">Wants to run <code class="tool-name" data-testid="inbox-gate-tool">{{ item.toolName }}</code>.</p>
                  <pre class="tool-args" data-testid="inbox-gate-args">{{ item.formattedInput }}</pre>
                  <div class="actions">
                    <button type="button" class="of-btn of-btn--primary" data-testid="inbox-allow" [disabled]="item.pending" (click)="decide(item.id, 'allow')">Approve</button>
                    <button type="button" class="of-btn of-btn--secondary" data-testid="inbox-deny" [disabled]="item.pending" (click)="decide(item.id, 'deny')">Deny</button>
                  </div>
                  @if (item.error; as error) {
                    <p class="of-error" data-testid="inbox-error">{{ error }}</p>
                  }
                </div>
              </article>
            } @empty {
              <div class="empty" data-testid="inbox-empty">
                <span class="empty-title">Nothing needs you</span>
                <span>Gates, questions, budget incidents and manager proposals show up here.</span>
              </div>
            }
          </div>
        }
        @case ('questions') {
          <p class="coming" data-testid="inbox-questions-coming">Questions from agents are coming with phase 4 tables/governance.</p>
        }
        @case ('proposals') {
          <p class="coming" data-testid="inbox-proposals-coming">Governance proposals are coming with phase 4 tables/governance.</p>
        }
      }
      </div>
    </section>
  `,
  styles: `
    :host { display: block; flex: 1; min-width: 0; max-width: 54rem; margin: 0 auto; }
    .inbox { display: flex; flex-direction: column; gap: .75rem; padding: 1rem; width: 100%; box-sizing: border-box; }
    .title-row { display: flex; align-items: center; gap: .375rem; flex-wrap: wrap; }
    .title { margin: 0; flex: 1; font-size: 1.25rem; font-weight: 600; }
    .count { display: inline-flex; min-width: 1rem; height: 1rem; padding: 0 .25rem; margin-left: .5rem; border-radius: .5rem; background: var(--accent); color: var(--on-accent); font-size: .625rem; font-weight: 600; align-items: center; justify-content: center; }
    .tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--line); }
    .tab { height: 1.875rem; padding: 0 .75rem; border: 0; border-bottom: 1px solid transparent; background: transparent; color: var(--mut); cursor: pointer; font: inherit; }
    .tab.active { color: var(--fg); border-bottom-color: var(--accent); }
    .tabpanel { display: flex; flex-direction: column; gap: .75rem; }
    .filters { display: flex; flex-wrap: wrap; gap: .375rem; }
    .filter-chip { height: 1.625rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: 1rem; background: var(--panel); color: var(--fg); font-size: .75rem; cursor: pointer; }
    .filter-chip.active { background: var(--active); }
    .filter-chip:disabled { color: var(--faint); cursor: not-allowed; }
    .gate-list { display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
    .gate-card { display: flex; gap: .75rem; min-width: 0; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .avatar { display: flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); }
    .gate-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .gate-meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .session-label { font-weight: 500; }
    .gate-sentence { margin: 0; }
    .tool-name { font-family: var(--mono); font-size: .75rem; padding: 0 .375rem; border-radius: .25rem; background: var(--sunk); }
    .age { margin-left: auto; font-size: .6875rem; color: var(--faint); }
    .tool-args { margin: 0; overflow: auto; max-height: 10rem; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: .75rem; padding: .375rem .5rem; border-radius: .375rem; background-color: var(--term-bg); color: var(--term-fg); border: 1px solid var(--line); }
    .actions { display: flex; gap: .5rem; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: .375rem; padding: 4rem 1rem; color: var(--mut); }
    .empty-title { color: var(--fg); font-weight: 500; }
    .coming { color: var(--mut); padding: 1rem 0; }
  `,
})
export class InboxComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  protected readonly filters = FILTERS;
  protected readonly needsBackendSupport = NEEDS_BACKEND_SUPPORT;
  protected readonly tabs = TABS;
  protected readonly tabPanelId = 'inbox-tabpanel';
  protected readonly tab = signal<InboxTab>('gates');
  private readonly now = signal(Date.now());
  private readonly pendingIds = signal<ReadonlySet<string>>(new Set());
  private readonly errorsById = signal<Readonly<Record<string, string>>>({});

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  private readonly gates = computed(() =>
    this.events.approvals().map((approval) => {
      const session = this.events.sessions().find((s) => s.id === approval.sessionId);
      const sessionName = session ? session.name : approval.sessionId;
      const sessionEmoji = session ? session.emoji : '';
      return { ...approval, sessionName, sessionEmoji, formattedInput: JSON.stringify(approval.toolInput, null, 2) };
    }),
  );

  readonly items = computed(() =>
    this.gates().map((gate) => ({
      ...gate,
      pending: this.pendingIds().has(gate.id),
      error: this.errorsById()[gate.id],
      ageLabel: compactElapsedLabel(elapsedSecondsSince(gate.createdAt, this.now())),
    })),
  );

  protected onTabKeydown(event: KeyboardEvent): void {
    const currentIndex = TABS.findIndex((entry) => entry.key === this.tab());
    const targetIndex = tabIndexAfterKey(event.key, currentIndex);
    if (targetIndex === undefined) return;
    event.preventDefault();
    this.tab.set(TABS[targetIndex].key);
    const tabButtons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
    tabButtons[targetIndex].focus();
  }

  async decide(id: string, behavior: 'allow' | 'deny'): Promise<void> {
    if (this.pendingIds().has(id)) return;
    this.setPending(id, true);
    this.clearError(id);
    const result = await decideApproval(this.api, id, behavior);
    if (result.outcome === 'already-resolved') this.removeFromSharedApprovals(id);
    else if (result.outcome === 'failed') this.setError(id, result.message);
    this.setPending(id, false);
  }

  private setPending(id: string, isPending: boolean): void {
    this.pendingIds.update((ids) => {
      const next = new Set(ids);
      if (isPending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private setError(id: string, message: string): void {
    this.errorsById.update((errors) => ({ ...errors, [id]: message }));
  }

  private clearError(id: string): void {
    this.errorsById.update((errors) => Object.fromEntries(Object.entries(errors).filter(([key]) => key !== id)));
  }

  private removeFromSharedApprovals(id: string): void {
    this.events.approvals.update((all) => all.filter((approval) => approval.id !== id));
  }
}
