import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { GovernanceProposalView, ManagerGovernanceView, ResourceAccessPayload } from '@openfleet/shared';
import { showBidiControlsAsEscapes } from '../core/bidi-escapes';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { proposalDetailsOf } from '../inbox/governance-details';
import { GovernanceResourceNames } from '../inbox/governance-resource-names.service';

const GRANTS_NOT_ENFORCED_LABEL = 'informational: not enforced yet';

/** The governance of one manager: what waits for a human, what was refused and why, what was decided, and the grants on record. */
@Component({
  selector: 'of-manager-governance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="governance" aria-labelledby="manager-governance-title" data-testid="manager-governance">
      <h2 class="title" id="manager-governance-title">Governance</h2>
      @if (view(); as view) {
        @if (isEmpty()) {
          <p class="muted">No proposal yet.</p>
        }
        @if (pending().length > 0) {
          <div data-testid="manager-governance-pending">
            <h3 class="subtitle">Pending <a class="link" routerLink="/inbox">Decide in the Inbox</a></h3>
            <ul class="entries">
              @for (entry of pending(); track entry.id) {
                <li class="entry"><span class="summary">{{ entry.summary }}</span><span class="incident">Incident: {{ entry.incident }}</span></li>
              }
            </ul>
          </div>
        }
        @if (denied().length > 0) {
          <div data-testid="manager-governance-denied">
            <h3 class="subtitle">Denied</h3>
            <ul class="entries">
              @for (entry of denied(); track entry.id) {
                <li class="entry"><span class="summary">{{ entry.summary }}</span><span class="incident">Reason: {{ entry.reason }}</span></li>
              }
            </ul>
          </div>
        }
        @if (view.governanceEvictedDenials > 0) {
          <p class="muted">{{ view.governanceEvictedDenials }} older {{ view.governanceEvictedDenials === 1 ? 'denial' : 'denials' }} evicted</p>
        }
        @if (history().length > 0) {
          <div data-testid="manager-governance-history">
            <h3 class="subtitle">History</h3>
            <ul class="entries">
              @for (entry of history(); track entry.id) {
                <li class="entry"><span class="summary">{{ entry.summary }}</span><span class="status">{{ entry.status }}</span></li>
              }
            </ul>
          </div>
        }
        @if (grants().length > 0) {
          <div data-testid="manager-governance-grants">
            <h3 class="subtitle">Resource grants <span class="muted">(${GRANTS_NOT_ENFORCED_LABEL})</span></h3>
            <ul class="entries">
              @for (grant of grants(); track grant.id) {
                <li class="entry"><span class="summary">{{ grant.resourceName }}</span><span class="status">{{ grant.access }} as {{ grant.role }}</span></li>
              }
            </ul>
          </div>
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; margin: 0 1.25rem 1.25rem; }
    .governance { display: flex; flex-direction: column; gap: .5rem; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .title { margin: 0; font-size: 1rem; font-weight: 600; }
    .subtitle { margin: 0 0 .25rem; font-size: .75rem; font-weight: 600; color: var(--mut); }
    .muted { margin: 0; font-size: .75rem; color: var(--mut); font-weight: 400; }
    .link { margin-left: .5rem; color: var(--accent); font-weight: 400; }
    .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .375rem; }
    .entry { display: flex; flex-direction: column; gap: .125rem; min-width: 0; }
    .summary { white-space: pre-wrap; overflow-wrap: anywhere; }
    .incident, .status { font-size: .75rem; color: var(--mut); white-space: pre-wrap; overflow-wrap: anywhere; }
  `,
})
export class ManagerGovernanceComponent {
  readonly managerId = input.required<string>();
  readonly projectId = input<string | undefined>(undefined);
  private readonly api = inject(FleetApiService);
  private readonly events = inject(FleetEventsService);
  private readonly resourceNames = inject(GovernanceResourceNames);
  protected readonly view = signal<ManagerGovernanceView | undefined>(undefined);
  private loadCount = 0;

  constructor() {
    effect(() => {
      const managerId = this.managerId();
      this.events.proposals();
      untracked(() => void this.load(managerId));
    });
  }

  private async load(managerId: string): Promise<void> {
    const loadNumber = ++this.loadCount;
    try {
      const view = await this.api.getManagerGovernance(managerId);
      const isStale = loadNumber !== this.loadCount;
      if (isStale) return;
      this.requestResourceNamesOf(view);
      this.view.set(view);
    } catch {
      // The section keeps what it last showed.
    }
  }

  private requestResourceNamesOf(view: ManagerGovernanceView): void {
    const projectId = this.projectId();
    view.resourceGrants.forEach((grant) => this.resourceNames.request({ projectId, ...grant }));
    [...view.pending, ...view.denied, ...view.history]
      .filter((proposal) => proposal.kind === 'resourceAccess')
      .forEach((proposal) => this.resourceNames.request({ projectId, ...(proposal.payload as ResourceAccessPayload) }));
  }

  private summaryOf(proposal: GovernanceProposalView): string {
    const details = proposalDetailsOf(proposal, (access) => this.resourceNames.nameOf({ projectId: this.projectId(), ...access }));
    return proposal.kind === 'law' ? details[0].value : details.map(({ label, value }) => `${label}: ${value}`).join(' · ');
  }

  private entryOf(proposal: GovernanceProposalView) {
    return {
      id: proposal.id,
      summary: this.summaryOf(proposal),
      incident: showBidiControlsAsEscapes(proposal.incident),
      reason: showBidiControlsAsEscapes(proposal.denialReason ?? ''),
      status: proposal.status,
    };
  }

  protected readonly pending = computed(() => (this.view()?.pending ?? []).map((proposal) => this.entryOf(proposal)));
  protected readonly denied = computed(() => (this.view()?.denied ?? []).map((proposal) => this.entryOf(proposal)));
  protected readonly history = computed(() => (this.view()?.history ?? []).map((proposal) => this.entryOf(proposal)));
  protected readonly grants = computed(() =>
    (this.view()?.resourceGrants ?? []).map((grant) => ({
      id: grant.id,
      resourceName: showBidiControlsAsEscapes(this.resourceNames.nameOf({ projectId: this.projectId(), ...grant })),
      access: grant.access,
      role: showBidiControlsAsEscapes(grant.role),
    })),
  );

  protected readonly isEmpty = computed(() => {
    const view = this.view();
    const hasNothingToShow = view !== undefined && [view.pending, view.denied, view.history, view.resourceGrants].every((list) => list.length === 0);
    return hasNothingToShow && view.governanceEvictedDenials === 0;
  });
}
