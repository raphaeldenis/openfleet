import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MAX_DENIAL_REASON_CHARS, type GovernanceProposalView, type ResourceAccessPayload } from '@openfleet/shared';
import { showBidiControlsAsEscapes, showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { copyFor } from '../core/error-copy';
import { FleetApiService, type ProposalDecision } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { compactElapsedLabel, elapsedSecondsSince } from '../design/elapsed-time';
import { ErrorLineComponent } from '../design/error-line.component';
import { KindBadgeComponent, type InboxKind } from '../design/kind-badge.component';
import { tickingNow } from '../working-state/working-state-freshness';
import { proposalDetailsOf, type Detail } from './governance-details';
import { GovernanceResourceNames } from './governance-resource-names.service';

const REASON_REQUIRED_HINT = `A reason is required (1 to ${MAX_DENIAL_REASON_CHARS} characters).`;
const COPY_INTO_LAWS_INSTRUCTION = 'Copy this into the Laws section of the mission note.';

const BADGE_KIND_BY_PROPOSAL_KIND: Record<GovernanceProposalView['kind'], InboxKind> = { law: 'law', permission: 'permission', resourceAccess: 'resource' };

interface ApprovedText {
  readonly proposalId: string;
  readonly managerName: string;
  readonly text: string;
  readonly noteQuery: { projectId: string | undefined; noteId: string } | undefined;
}

/** The cards of the proposals waiting for a human decision. Every proposal text is drawn as inert plain text. */
@Component({
  selector: 'of-governance-proposals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, KindBadgeComponent, RouterLink],
  template: `
    @for (card of cards(); track card.id) {
      <article class="card" data-testid="governance-card">
        <span class="avatar" aria-hidden="true">{{ card.managerEmoji }}</span>
        <div class="body">
          <div class="meta">
            <of-kind-badge [kind]="card.badgeKind" />
            <span class="manager" data-testid="governance-manager">{{ card.managerName }}</span>
            <span class="age" data-testid="governance-age">{{ card.ageLabel }}</span>
          </div>
          <dl class="details">
            @for (detail of card.details; track detail.label) {
              <div class="detail">
                <dt>{{ detail.label }}</dt>
                <dd>{{ detail.value }}</dd>
              </div>
            }
          </dl>
          <p class="incident"><span class="incident-label">Incident</span> {{ card.incident }}</p>
          @if (denyingId() === card.id) {
            <div class="deny" role="group" [attr.aria-label]="'Deny proposal from ' + card.managerName">
              <label class="deny-label" [for]="'governance-reason-' + card.id">Reason for denying</label>
              <textarea
                #reasonField
                class="reason"
                rows="2"
                [id]="'governance-reason-' + card.id"
                [attr.maxlength]="maxReasonChars"
                [attr.aria-describedby]="'governance-reason-hint-' + card.id"
                [value]="reason()"
                (input)="reason.set($any($event.target).value)"
              ></textarea>
              <p class="hint" [id]="'governance-reason-hint-' + card.id">${REASON_REQUIRED_HINT}</p>
              <div class="actions">
                <button type="button" class="of-btn of-btn--primary" data-testid="governance-confirm-deny" [disabled]="isReasonBlank() || card.isPending" (click)="decide(card.id, { decision: 'deny', reason: reason().trim() })">Confirm denial</button>
                <button type="button" class="of-btn of-btn--secondary" data-testid="governance-cancel-deny" (click)="cancelDenial()">Cancel</button>
              </div>
            </div>
          } @else {
            <div class="actions">
              <button type="button" class="of-btn of-btn--primary" data-testid="governance-approve" [attr.aria-label]="'Approve proposal from ' + card.managerName" [disabled]="card.isPending" (click)="decide(card.id, { decision: 'approve' })">Approve</button>
              <button type="button" class="of-btn of-btn--secondary" data-testid="governance-deny" [attr.aria-label]="'Deny proposal from ' + card.managerName" [disabled]="card.isPending" (click)="startDenial(card.id)">Deny</button>
            </div>
          }
          @if (card.error; as error) {
            <p><of-error-line data-testid="governance-error" [glyph]="false">{{ error }}</of-error-line></p>
          }
        </div>
      </article>
    }
    @for (approved of approvedTexts(); track approved.proposalId) {
      <article class="card" data-testid="governance-approved">
        <div class="body">
          <p class="approved-title" role="status"><span class="check" aria-hidden="true">✓</span>Approved for {{ approved.managerName }}</p>
          <p class="approved-text">{{ approved.text }}</p>
          <p class="instruction">${COPY_INTO_LAWS_INSTRUCTION}</p>
          <div class="actions">
            @if (approved.noteQuery; as query) {
              <a class="of-btn of-btn--secondary" routerLink="/notes" [queryParams]="query" [attr.aria-label]="'Open the mission note of ' + approved.managerName">Open the note</a>
            }
            <button type="button" class="of-btn of-btn--secondary" [attr.aria-label]="'Dismiss approval of ' + approved.managerName" (click)="dismissApproved(approved.proposalId)">Dismiss</button>
          </div>
        </div>
      </article>
    }
  `,
  styles: `
    :host { display: contents; }
    .card { display: flex; gap: .75rem; min-width: 0; padding: .875rem 1rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .avatar { display: flex; align-items: center; justify-content: center; flex: none; width: 2rem; height: 2rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--sunk); }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }
    .meta { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .manager { font-weight: 500; overflow-wrap: anywhere; }
    .age { margin-left: auto; font-size: .6875rem; color: var(--mut); }
    .details { margin: 0; display: flex; flex-direction: column; gap: .25rem; }
    .detail { display: flex; gap: .5rem; min-width: 0; }
    .detail dt { flex: none; min-width: 5.5rem; font-size: .75rem; color: var(--mut); }
    .detail dd { margin: 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .incident { margin: 0; font-size: .75rem; color: var(--mut); white-space: pre-wrap; overflow-wrap: anywhere; }
    .incident-label { font-weight: 600; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .deny { display: flex; flex-direction: column; gap: .375rem; }
    .deny-label { font-size: .75rem; font-weight: 500; }
    .reason { width: 100%; box-sizing: border-box; padding: .375rem .5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg); font: inherit; resize: vertical; }
    .reason:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .hint { margin: 0; font-size: .75rem; color: var(--mut); }
    .approved-title { display: flex; align-items: center; gap: .5rem; margin: 0; font-weight: 500; }
    .check { color: var(--state-idle); }
    .approved-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .instruction { margin: 0; font-size: .75rem; color: var(--mut); }
  `,
})
export class GovernanceProposalsComponent {
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly now = tickingNow();
  protected readonly maxReasonChars = MAX_DENIAL_REASON_CHARS;
  protected readonly denyingId = signal<string | undefined>(undefined);
  protected readonly reason = signal('');
  protected readonly isReasonBlank = computed(() => this.reason().trim() === '');
  protected readonly approvedTexts = signal<readonly ApprovedText[]>([]);
  private readonly pendingIds = signal<ReadonlySet<string>>(new Set());
  private readonly errorsById = signal<Readonly<Record<string, string>>>({});
  private readonly resourceNames = inject(GovernanceResourceNames);
  private readonly reasonField = viewChild<ElementRef<HTMLTextAreaElement>>('reasonField');

  constructor() {
    effect(() => this.reasonField()?.nativeElement.focus());
    effect(() => {
      const proposals = this.events.proposals();
      this.sessionsById();
      untracked(() => proposals.forEach((proposal) => this.requestResourceNameOf(proposal)));
    });
  }

  private readonly sessionsById = computed(() => new Map(this.events.sessions().map((session) => [session.id, session])));
  private readonly managersById = computed(() => new Map(this.events.managers().map((manager) => [manager.sessionId, manager])));

  private projectIdOf(managerId: string): string | undefined {
    return this.sessionsById().get(managerId)?.projectId;
  }

  private managerNameOf(managerId: string): string {
    const session = this.sessionsById().get(managerId);
    return showInvisibleControlsAsEscapes(session ? session.name : managerId);
  }

  protected readonly cards = computed(() => {
    const nowMs = this.now();
    return this.events.proposals().map((proposal) => ({
      id: proposal.id,
      badgeKind: BADGE_KIND_BY_PROPOSAL_KIND[proposal.kind],
      managerName: this.managerNameOf(proposal.managerId),
      managerEmoji: this.sessionsById().get(proposal.managerId)?.emoji ?? '',
      ageLabel: compactElapsedLabel(elapsedSecondsSince(proposal.createdAt, nowMs)),
      incident: showBidiControlsAsEscapes(proposal.incident),
      details: this.detailsOf(proposal),
      isPending: this.pendingIds().has(proposal.id),
      error: this.errorsById()[proposal.id],
    }));
  });

  private detailsOf(proposal: GovernanceProposalView): Detail[] {
    const projectId = this.projectIdOf(proposal.managerId);
    return proposalDetailsOf(proposal, (access) => this.resourceNames.nameOf({ projectId, ...access }));
  }

  private requestResourceNameOf(proposal: GovernanceProposalView): void {
    if (proposal.kind !== 'resourceAccess') return;
    this.resourceNames.request({ projectId: this.projectIdOf(proposal.managerId), ...(proposal.payload as ResourceAccessPayload) });
  }

  protected startDenial(proposalId: string): void {
    this.reason.set('');
    this.denyingId.set(proposalId);
  }

  protected cancelDenial(): void {
    this.denyingId.set(undefined);
  }

  protected dismissApproved(proposalId: string): void {
    this.approvedTexts.update((all) => all.filter((approved) => approved.proposalId !== proposalId));
  }

  protected async decide(proposalId: string, decision: ProposalDecision): Promise<void> {
    if (this.pendingIds().has(proposalId)) return;
    const proposal = this.events.proposals().find((candidate) => candidate.id === proposalId);
    this.setPending(proposalId, true);
    this.errorsById.update((errors) => Object.fromEntries(Object.entries(errors).filter(([id]) => id !== proposalId)));
    try {
      await this.api.decideProposal(proposalId, decision);
      this.events.proposals.update((all) => all.filter((candidate) => candidate.id !== proposalId));
      this.denyingId.set(undefined);
      if (proposal && decision.decision === 'approve') this.rememberApprovedText(proposal);
    } catch (error) {
      this.errorsById.update((errors) => ({ ...errors, [proposalId]: copyFor(error, { action: 'generic' }).text }));
    } finally {
      this.setPending(proposalId, false);
    }
  }

  private rememberApprovedText(proposal: GovernanceProposalView): void {
    if (proposal.kind === 'resourceAccess') return;
    const missionNoteId = this.managersById().get(proposal.managerId)?.missionNoteId;
    const noteQuery = missionNoteId === undefined ? undefined : { projectId: this.projectIdOf(proposal.managerId), noteId: missionNoteId };
    const text = this.detailsOf(proposal).map(({ label, value }) => (proposal.kind === 'law' ? value : `${label}: ${value}`)).join('\n');
    this.approvedTexts.update((all) => [...all, { proposalId: proposal.id, managerName: this.managerNameOf(proposal.managerId), text, noteQuery }]);
  }

  private setPending(proposalId: string, isPending: boolean): void {
    this.pendingIds.update((ids) => {
      const next = new Set(ids);
      if (isPending) next.add(proposalId);
      else next.delete(proposalId);
      return next;
    });
  }
}
