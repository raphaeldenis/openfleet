import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { decideApproval } from '../core/decide-approval';
import { elapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
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

@Component({
  selector: 'of-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KindBadgeComponent],
  template: `
    <section class="inbox" data-testid="inbox">
      <header class="inbox-header">
        <h2>Inbox <span class="count" data-testid="inbox-count">{{ events.approvals().length }}</span></h2>
      </header>
      <nav class="tabs" role="tablist">
        <button type="button" class="tab" [class.active]="tab() === 'gates'" data-testid="inbox-tab-gates" (click)="tab.set('gates')">Gates</button>
        <button type="button" class="tab" [class.active]="tab() === 'questions'" data-testid="inbox-tab-questions" (click)="tab.set('questions')">Questions from agents</button>
        <button type="button" class="tab" [class.active]="tab() === 'proposals'" data-testid="inbox-tab-proposals" (click)="tab.set('proposals')">Governance proposals</button>
      </nav>

      @switch (tab()) {
        @case ('gates') {
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
          <div class="gate-list">
            @for (item of items(); track item.id) {
              <article class="gate-card" data-testid="inbox-gate-card">
                <of-kind-badge kind="gate" />
                <div class="gate-body">
                  <div class="gate-meta">
                    <span class="session-label" data-testid="inbox-gate-session">{{ item.sessionLabel }}</span>
                    <code class="tool-name" data-testid="inbox-gate-tool">{{ item.toolName }}</code>
                    <span class="age" data-testid="inbox-gate-age">{{ item.ageLabel }}</span>
                  </div>
                  <pre
                    class="tool-args"
                    style="overflow: auto; max-height: 10rem; white-space: pre-wrap"
                    data-testid="inbox-gate-args"
                  >{{ item.formattedInput }}</pre>
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
              <p class="empty" data-testid="inbox-empty">Nothing waiting for you.</p>
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
    </section>
  `,
  styles: `
    .inbox { display: flex; flex-direction: column; gap: .75rem; padding: 1rem; width: 100%; }
    .inbox-header { display: flex; align-items: center; }
    .count { display: inline-flex; min-width: 1rem; height: 1rem; padding: 0 .25rem; margin-left: .5rem; border-radius: .5rem; background: var(--accent); color: var(--on-accent); font-size: .625rem; font-weight: 600; align-items: center; justify-content: center; }
    .tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--line); }
    .tab { height: 1.875rem; padding: 0 .75rem; border: 0; border-bottom: 1px solid transparent; background: transparent; color: var(--mut); cursor: pointer; font: inherit; }
    .tab.active { color: var(--fg); border-bottom-color: var(--accent); }
    .filters { display: flex; flex-wrap: wrap; gap: .375rem; }
    .filter-chip { height: 1.625rem; padding: 0 .625rem; border: 1px solid var(--line); border-radius: 1rem; background: var(--panel); color: var(--fg); font-size: .75rem; cursor: pointer; }
    .filter-chip.active { background: var(--active); }
    .filter-chip:disabled { color: var(--faint); cursor: not-allowed; }
    .gate-list { display: flex; flex-direction: column; gap: .5rem; }
    .gate-card { display: flex; gap: .625rem; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .gate-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .gate-meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .session-label { font-weight: 500; }
    .tool-name { font-family: var(--mono); font-size: .75rem; padding: 0 .375rem; border-radius: .25rem; background: var(--sunk); }
    .age { margin-left: auto; font-size: .6875rem; color: var(--faint); }
    .tool-args { font-family: var(--mono); font-size: .8125rem; padding: .5rem .625rem; border-radius: .375rem; background: var(--sunk); border: 1px solid var(--line); margin: 0; }
    .actions { display: flex; gap: .5rem; }
    .empty, .coming { color: var(--mut); padding: 1rem 0; }
  `,
})
export class InboxComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  protected readonly filters = FILTERS;
  protected readonly needsBackendSupport = NEEDS_BACKEND_SUPPORT;
  protected readonly tab = signal<InboxTab>('gates');
  private readonly now = signal(Date.now());
  private readonly pendingIds = signal<ReadonlySet<string>>(new Set());
  private readonly dismissedIds = signal<ReadonlySet<string>>(new Set());
  private readonly errorsById = signal<Readonly<Record<string, string>>>({});

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  readonly items = computed(() =>
    this.events.approvals()
      .filter((approval) => !this.dismissedIds().has(approval.id))
      .map((approval) => {
        const session = this.events.sessions().find((s) => s.id === approval.sessionId);
        const sessionLabel = session ? `${session.emoji} ${session.name}` : approval.sessionId;
        return {
          ...approval,
          sessionLabel,
          pending: this.pendingIds().has(approval.id),
          error: this.errorsById()[approval.id],
          formattedInput: JSON.stringify(approval.toolInput, null, 2),
          ageLabel: elapsedLabel(elapsedSecondsSince(approval.createdAt, this.now())),
        };
      }),
  );

  async decide(id: string, behavior: 'allow' | 'deny'): Promise<void> {
    if (this.pendingIds().has(id)) return;
    this.setPending(id, true);
    this.clearError(id);
    const result = await decideApproval(this.api, id, behavior);
    if (result.outcome === 'already-resolved') this.dismiss(id);
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

  private dismiss(id: string): void {
    this.dismissedIds.update((ids) => new Set(ids).add(id));
  }
}
