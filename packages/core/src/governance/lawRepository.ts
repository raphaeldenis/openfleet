import type { DatabaseSync } from 'node:sqlite';
import type { LawSourceKind, LawStatus, LawView } from '@openfleet/shared';

interface LawRow {
  id: string; manager_id: string; text: string; status: LawStatus; revision: number; created_at: string; updated_at: string;
  withdrawn_at: string | null; approved_by: string | null; updated_by: string | null; withdrawn_by: string | null;
  source_kind: LawSourceKind; source_created_at: string | null; proposal_id: string | null;
}

export interface LawOfApprovedProposal {
  id: string;
  managerId: string;
  text: string;
  approvedBy: string;
  proposalId: string;
  approvedAt: string;
}

const toView = (row: LawRow): LawView => ({
  id: row.id,
  managerId: row.manager_id,
  text: row.text,
  status: row.status,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  withdrawnAt: row.withdrawn_at ?? undefined,
  approvedBy: row.approved_by ?? undefined,
  updatedBy: row.updated_by ?? undefined,
  withdrawnBy: row.withdrawn_by ?? undefined,
  source: row.source_kind,
  sourceCreatedAt: row.source_created_at ?? undefined,
  proposalId: row.proposal_id ?? undefined,
});

export class LawRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Records the law an approved proposal enacts; the unique proposal id refuses a second law for the same proposal. */
  insertOfApprovedProposal(law: LawOfApprovedProposal): void {
    this.db.prepare(`INSERT INTO laws (id, manager_id, text, status, revision, created_at, updated_at, approved_by, updated_by, source_kind, proposal_id)
      VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, 'proposal', ?)`)
      .run(law.id, law.managerId, law.text, law.approvedAt, law.approvedAt, law.approvedBy, law.approvedBy, law.proposalId);
  }

  /** Every law of the manager, active and withdrawn, oldest first. */
  allOf(managerId: string): LawView[] {
    const rows = this.db.prepare('SELECT * FROM laws WHERE manager_id = ? ORDER BY created_at, rowid').all(managerId) as unknown as LawRow[];
    return rows.map(toView);
  }
}
