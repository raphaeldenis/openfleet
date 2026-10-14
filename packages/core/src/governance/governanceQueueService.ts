import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_AUDIT_HISTORY_PER_MANAGER, MAX_DENIED_HISTORY_PER_MANAGER, MAX_PENDING_PROPOSALS_PER_MANAGER, OpenFleetError,
  type GovernanceProposalView, type ManagerGovernanceView, type ProposalKind, type ProposalPayload, type ProposalStatus, type ResourceAccessPayload,
} from '@openfleet/shared';
import { inTransaction } from '../db/transaction.js';
import type { EventBus } from '../events/eventBus.js';
import type { ManagerLinkTargets } from '../managers/managerService.js';
import { NoteNotFoundError } from '../notes/noteService.js';
import { StoreNotFoundError } from '../stores/dataStoreRepository.js';
import { GovernanceQueueFullError, ProposalNotFoundError } from './governanceErrors.js';
import { lawPayloadOf, permissionPayloadOf, resourceAccessPayloadOf, storedDenialReason, storedIncident } from './proposalInput.js';
import { ProposalRepository } from './proposalRepository.js';

/** Who is a manager, and in which project it works. */
export interface ManagerDirectory {
  isManager(sessionId: string): boolean;
  projectIdOf(sessionId: string): string | undefined;
}

export interface GovernanceQueueDeps {
  db: DatabaseSync;
  bus: Pick<EventBus, 'emit'>;
  clock: () => string;
  newId: () => string;
  managers: ManagerDirectory;
  linkTargets: ManagerLinkTargets;
}

export interface ProposalFiled {
  proposal: GovernanceProposalView;
  /** True when an identical proposal was already pending: it is returned instead of a new one. */
  deduplicated: boolean;
}

export type Decision = { proposalId: string; decision: 'approve' } | { proposalId: string; decision: 'deny'; reason?: string };

/**
 * The proposals a manager files and a human answers. A pending proposal grants nothing; the laws and permissions in force
 * stay the prose of the mission note, which this service never writes.
 */
export class GovernanceQueueService {
  private readonly proposals: ProposalRepository;

  constructor(private readonly deps: GovernanceQueueDeps) {
    this.proposals = new ProposalRepository(deps.db);
  }

  proposeLaw({ managerId, text, incident }: { managerId: string; text: string; incident: string }): ProposalFiled {
    this.requireManager(managerId);
    return this.enqueueUnlessDuplicate({ managerId, kind: 'law', incident: storedIncident(incident), payload: lawPayloadOf({ text }) });
  }

  proposePermission({ managerId, incident, ...fields }: { managerId: string; action: string; scope: string; condition: string; exclusions: string; incident: string }): ProposalFiled {
    this.requireManager(managerId);
    return this.enqueueUnlessDuplicate({ managerId, kind: 'permission', incident: storedIncident(incident), payload: permissionPayloadOf(fields) });
  }

  requestResourceAccess({ managerId, incident, ...fields }: { managerId: string; resourceType: string; resourceId: string; access: string; role: string; incident: string }): ProposalFiled {
    this.requireManager(managerId);
    const visibleIncident = storedIncident(incident);
    const payload = resourceAccessPayloadOf(fields);
    this.requireResourceOfManagerProject({ managerId, payload });
    return this.enqueueUnlessDuplicate({ managerId, kind: 'resourceAccess', incident: visibleIncident, payload });
  }

  /** The manager takes back a pending proposal of its own. */
  withdraw({ managerId, proposalId }: { managerId: string; proposalId: string }): GovernanceProposalView {
    this.requireManager(managerId);
    const withdrawn = inTransaction(this.deps.db, 'governance_withdraw', () => {
      const current = this.proposals.find(proposalId);
      const isOwnProposal = current?.managerId === managerId;
      if (!isOwnProposal) throw new ProposalNotFoundError();
      this.answer({ proposalId, status: 'withdrawn' });
      this.evictOldestAudit(managerId);
      return this.proposals.find(proposalId)!;
    });
    this.deps.bus.emit({ type: 'governance.resolved', proposal: withdrawn });
    return withdrawn;
  }

  /** A human approves or denies a pending proposal; approving a resource access records its grant in the same transaction. */
  decide(decision: Decision): GovernanceProposalView {
    const answered = this.recordDecision(decision);
    this.deps.bus.emit({ type: 'governance.resolved', proposal: answered });
    return answered;
  }

  /** The proposals of every manager in the given status, oldest filing first. */
  listByStatus(status: ProposalStatus): GovernanceProposalView[] {
    return this.proposals.allWithStatus(status);
  }

  /** True when the session is a manager: the governance view of any other session does not exist. */
  isManager(sessionId: string): boolean {
    return this.deps.managers.isManager(sessionId);
  }

  private recordDecision(decision: Decision): GovernanceProposalView {
    const denialReason = decision.decision === 'deny' ? storedDenialReason(decision.reason) : undefined;
    return inTransaction(this.deps.db, 'governance_decide', () => {
      const { proposalId } = decision;
      const status = decision.decision === 'approve' ? 'approved' : 'denied';
      this.answer({ proposalId, status, denialReason });
      const answered = this.proposals.find(proposalId)!;
      if (status === 'denied') {
        this.evictOldestDenials(answered.managerId);
        return answered;
      }
      this.recordGrantOfApproved(answered);
      this.evictOldestAudit(answered.managerId);
      return answered;
    });
  }

  viewOf(managerId: string): ManagerGovernanceView {
    this.requireManager(managerId);
    return {
      resourceGrants: this.proposals.grantsOf(managerId),
      pending: this.proposals.pendingOf(managerId),
      denied: this.proposals.deniedOf(managerId),
      history: this.proposals.auditHistoryOf(managerId),
      governanceEvictedDenials: this.proposals.evictedDenialsOf(managerId),
    };
  }

  private requireManager(sessionId: string): void {
    if (!this.deps.managers.isManager(sessionId)) throw new OpenFleetError('not_a_manager', 'only a manager can use the governance queue.');
  }

  /** Returns the identical pending proposal of the manager when there is one (a second incident is not recorded, and a full queue does not refuse it); otherwise enqueues the proposal. */
  private enqueueUnlessDuplicate({ managerId, kind, incident, payload }: { managerId: string; kind: ProposalKind; incident: string; payload: ProposalPayload }): ProposalFiled {
    const filed = inTransaction(this.deps.db, 'governance_file', () => {
      const identicalPending = this.proposals.findPendingTwin({ managerId, kind, payload });
      if (identicalPending) return { proposal: identicalPending, deduplicated: true };
      const isQueueFull = this.proposals.countPending(managerId) >= MAX_PENDING_PROPOSALS_PER_MANAGER;
      if (isQueueFull) throw new GovernanceQueueFullError();
      const id = this.deps.newId();
      this.proposals.insert({ id, managerId, kind, incident, payload, createdAt: this.deps.clock() });
      return { proposal: this.proposals.find(id)!, deduplicated: false };
    });
    if (!filed.deduplicated) this.deps.bus.emit({ type: 'governance.proposed', proposal: filed.proposal });
    return filed;
  }

  /** Answers a pending proposal; a proposal already answered reads as already_resolved, an unknown one as not found. */
  private answer({ proposalId, status, denialReason }: { proposalId: string; status: 'approved' | 'denied' | 'withdrawn'; denialReason?: string }): void {
    const wasPending = this.proposals.answerIfPending({ id: proposalId, status, denialReason, decidedAt: this.deps.clock() });
    if (wasPending) return;
    const exists = this.proposals.find(proposalId) !== undefined;
    if (!exists) throw new ProposalNotFoundError();
    throw new OpenFleetError('already_resolved', 'the proposal is already resolved.');
  }

  private recordGrantOfApproved(approved: GovernanceProposalView): void {
    if (approved.kind !== 'resourceAccess') return;
    const payload = approved.payload as ResourceAccessPayload;
    this.requireResourceOfManagerProject({ managerId: approved.managerId, payload });
    this.proposals.upsertGrant({ id: this.deps.newId(), managerId: approved.managerId, ...payload, proposalId: approved.id, grantedAt: this.deps.clock() });
  }

  private evictOldestAudit(managerId: string): void {
    this.proposals.evictOldestBeyond({ managerId, statuses: ['approved', 'withdrawn'], keep: MAX_AUDIT_HISTORY_PER_MANAGER });
  }

  private evictOldestDenials(managerId: string): void {
    const evictedCount = this.proposals.evictOldestBeyond({ managerId, statuses: ['denied'], keep: MAX_DENIED_HISTORY_PER_MANAGER });
    if (evictedCount > 0) this.proposals.addEvictedDenials(managerId, evictedCount);
  }

  /** A table or note of another project reads like one that does not exist. */
  private requireResourceOfManagerProject({ managerId, payload }: { managerId: string; payload: ResourceAccessPayload }): void {
    const { resourceType, resourceId } = payload;
    const ownerProjectId = resourceType === 'dataStore' ? this.deps.linkTargets.storeProjectId(resourceId) : this.deps.linkTargets.noteProjectId(resourceId);
    const managerProjectId = this.deps.managers.projectIdOf(managerId);
    const isInManagerProject = ownerProjectId !== undefined && ownerProjectId === managerProjectId;
    if (isInManagerProject) return;
    throw resourceType === 'dataStore' ? new StoreNotFoundError(resourceId) : new NoteNotFoundError(resourceId);
  }
}
