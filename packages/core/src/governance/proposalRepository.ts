import type { DatabaseSync } from 'node:sqlite';
import {
  PAYLOAD_SCHEMA_BY_KIND, type GovernanceProposalView, type ProposalKind, type ProposalPayload, type ProposalStatus, type ResourceAccess, type ResourceGrantView, type ResourceType,
} from '@openfleet/shared';

const NEWEST_ANSWER_FIRST = 'decided_at DESC, rowid DESC';

interface ProposalRow {
  id: string; manager_id: string; kind: ProposalKind; status: ProposalStatus; incident: string; payload_json: string;
  denial_reason: string | null; created_at: string; decided_at: string | null;
}

interface GrantRow {
  id: string; resource_type: ResourceType; resource_id: string; role: string; access: ResourceAccess; proposal_id: string | null; granted_at: string;
}

export interface NewProposal {
  id: string;
  managerId: string;
  kind: ProposalKind;
  incident: string;
  payload: ProposalPayload;
  createdAt: string;
}

export interface GrantToUpsert {
  id: string;
  managerId: string;
  resourceType: ResourceType;
  resourceId: string;
  role: string;
  access: ResourceAccess;
  proposalId: string;
  grantedAt: string;
}

const toView = (row: ProposalRow): GovernanceProposalView => ({
  id: row.id,
  managerId: row.manager_id,
  kind: row.kind,
  status: row.status,
  incident: row.incident,
  payload: PAYLOAD_SCHEMA_BY_KIND[row.kind].parse(JSON.parse(row.payload_json)),
  denialReason: row.denial_reason ?? undefined,
  createdAt: row.created_at,
  decidedAt: row.decided_at ?? undefined,
});

const toGrantView = (row: GrantRow): ResourceGrantView => ({
  id: row.id, resourceType: row.resource_type, resourceId: row.resource_id, role: row.role, access: row.access,
  grantedAt: row.granted_at, proposalId: row.proposal_id ?? undefined,
});

const placeholdersFor = (values: readonly unknown[]) => values.map(() => '?').join(', ');

export class ProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(proposal: NewProposal): void {
    this.db.prepare('INSERT INTO governance_proposals (id, manager_id, kind, status, incident, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(proposal.id, proposal.managerId, proposal.kind, 'pending', proposal.incident, JSON.stringify(proposal.payload), proposal.createdAt);
  }

  find(id: string): GovernanceProposalView | undefined {
    const row = this.db.prepare('SELECT * FROM governance_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row ? toView(row) : undefined;
  }

  findPendingTwin({ managerId, kind, payload }: Pick<NewProposal, 'managerId' | 'kind' | 'payload'>): GovernanceProposalView | undefined {
    const row = this.db.prepare("SELECT * FROM governance_proposals WHERE manager_id = ? AND kind = ? AND payload_json = ? AND status = 'pending'")
      .get(managerId, kind, JSON.stringify(payload)) as ProposalRow | undefined;
    return row ? toView(row) : undefined;
  }

  countPending(managerId: string): number {
    const { count } = this.db.prepare("SELECT count(*) AS count FROM governance_proposals WHERE manager_id = ? AND status = 'pending'").get(managerId) as { count: number };
    return count;
  }

  /** Moves a pending proposal to its answer in one statement; false when it was not pending (another answer got there first, or it does not exist). */
  answerIfPending({ id, status, denialReason, decidedAt }: { id: string; status: Exclude<ProposalStatus, 'pending'>; denialReason?: string; decidedAt: string }): boolean {
    const { changes } = this.db.prepare("UPDATE governance_proposals SET status = ?, denial_reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, denialReason ?? null, decidedAt, id);
    return changes === 1;
  }

  /** Every manager's proposals in `status`: pending ones oldest filing first, answered ones newest answer first; the rowid breaks equal timestamps. */
  allWithStatus(status: ProposalStatus): GovernanceProposalView[] {
    const order = status === 'pending' ? 'created_at, rowid' : NEWEST_ANSWER_FIRST;
    const rows = this.db.prepare(`SELECT * FROM governance_proposals WHERE status = ? ORDER BY ${order}`).all(status) as unknown as ProposalRow[];
    return rows.map(toView);
  }

  pendingOf(managerId: string): GovernanceProposalView[] {
    return this.listOf({ managerId, statuses: ['pending'], order: 'created_at, rowid' });
  }

  deniedOf(managerId: string): GovernanceProposalView[] {
    return this.listOf({ managerId, statuses: ['denied'], order: NEWEST_ANSWER_FIRST });
  }

  auditHistoryOf(managerId: string): GovernanceProposalView[] {
    return this.listOf({ managerId, statuses: ['approved', 'withdrawn'], order: NEWEST_ANSWER_FIRST });
  }

  /** Deletes the oldest answers of the given statuses beyond the newest `keep`; answers decided at the same instant are ranked by filing order. Returns how many it deleted. */
  evictOldestBeyond({ managerId, statuses, keep }: { managerId: string; statuses: readonly ProposalStatus[]; keep: number }): number {
    const { changes } = this.db.prepare(`DELETE FROM governance_proposals WHERE id IN (
      SELECT id FROM governance_proposals WHERE manager_id = ? AND status IN (${placeholdersFor(statuses)}) ORDER BY ${NEWEST_ANSWER_FIRST} LIMIT -1 OFFSET ?)`)
      .run(managerId, ...statuses, keep);
    return Number(changes);
  }

  evictedDenialsOf(managerId: string): number {
    const row = this.db.prepare('SELECT governance_evicted_denials AS count FROM managers WHERE session_id = ?').get(managerId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  addEvictedDenials(managerId: string, count: number): void {
    this.db.prepare('UPDATE managers SET governance_evicted_denials = governance_evicted_denials + ? WHERE session_id = ?').run(count, managerId);
  }

  /** One grant per manager and resource: a new one replaces the role and the access of the old one. */
  upsertGrant(grant: GrantToUpsert): void {
    this.db.prepare(`INSERT INTO governance_resource_grants (id, manager_id, resource_type, resource_id, role, access, proposal_id, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(manager_id, resource_type, resource_id) DO UPDATE SET role = excluded.role, access = excluded.access, proposal_id = excluded.proposal_id, granted_at = excluded.granted_at`)
      .run(grant.id, grant.managerId, grant.resourceType, grant.resourceId, grant.role, grant.access, grant.proposalId, grant.grantedAt);
  }

  grantsOf(managerId: string): ResourceGrantView[] {
    const rows = this.db.prepare('SELECT * FROM governance_resource_grants WHERE manager_id = ? ORDER BY granted_at, rowid').all(managerId) as unknown as GrantRow[];
    return rows.map(toGrantView);
  }

  private listOf({ managerId, statuses, order }: { managerId: string; statuses: readonly ProposalStatus[]; order: string }): GovernanceProposalView[] {
    const rows = this.db.prepare(`SELECT * FROM governance_proposals WHERE manager_id = ? AND status IN (${placeholdersFor(statuses)}) ORDER BY ${order}`)
      .all(managerId, ...statuses) as unknown as ProposalRow[];
    return rows.map(toView);
  }
}
