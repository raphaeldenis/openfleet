import type { DatabaseSync } from 'node:sqlite';
import { PAYLOAD_SCHEMA_BY_KIND, type ProposalKind, type ProposalPayload, type WaitingProposalView } from '@openfleet/shared';

const FILING_ORDER = 'created_at, rowid';

interface WaitingRow {
  id: string; manager_id: string; kind: ProposalKind; incident: string; payload_json: string; created_at: string;
}

export interface NewWaitingProposal {
  id: string;
  managerId: string;
  kind: ProposalKind;
  incident: string;
  payload: ProposalPayload;
  createdAt: string;
}

const toView = (row: WaitingRow, position: number): WaitingProposalView => ({
  id: row.id,
  managerId: row.manager_id,
  kind: row.kind,
  incident: row.incident,
  payload: PAYLOAD_SCHEMA_BY_KIND[row.kind].parse(JSON.parse(row.payload_json)),
  createdAt: row.created_at,
  position,
});

/** The proposals a manager filed beyond its pending places, in filing order; every read and write is scoped to one manager. */
export class WaitingProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(proposal: NewWaitingProposal): void {
    this.db.prepare('INSERT INTO governance_waiting_proposals (id, manager_id, kind, incident, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(proposal.id, proposal.managerId, proposal.kind, proposal.incident, JSON.stringify(proposal.payload), proposal.createdAt);
  }

  listOf(managerId: string): WaitingProposalView[] {
    const rows = this.db.prepare(`SELECT * FROM governance_waiting_proposals WHERE manager_id = ? ORDER BY ${FILING_ORDER}`).all(managerId) as unknown as WaitingRow[];
    return rows.map((row, index) => toView(row, index + 1));
  }

  findTwin({ managerId, kind, payload }: Pick<NewWaitingProposal, 'managerId' | 'kind' | 'payload'>): WaitingProposalView | undefined {
    const twin = this.db.prepare('SELECT id FROM governance_waiting_proposals WHERE manager_id = ? AND kind = ? AND payload_json = ?')
      .get(managerId, kind, JSON.stringify(payload)) as { id: string } | undefined;
    return twin && this.listOf(managerId).find((waiting) => waiting.id === twin.id);
  }

  countOf(managerId: string): number {
    const { count } = this.db.prepare('SELECT count(*) AS count FROM governance_waiting_proposals WHERE manager_id = ?').get(managerId) as { count: number };
    return count;
  }

  /** The number of waiting proposals of each manager that has any. */
  countsByManager(): Record<string, number> {
    const rows = this.db.prepare('SELECT manager_id, count(*) AS count FROM governance_waiting_proposals GROUP BY manager_id').all() as { manager_id: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.manager_id, row.count]));
  }

  /** Moves the oldest waiting proposal of the manager into the pending proposals, byte for byte with its id and filing date; returns its id, or undefined when none waits. */
  releaseOldest(managerId: string): string | undefined {
    const row = this.db.prepare(`SELECT * FROM governance_waiting_proposals WHERE manager_id = ? ORDER BY ${FILING_ORDER} LIMIT 1`).get(managerId) as WaitingRow | undefined;
    if (!row) return undefined;
    this.db.prepare("INSERT INTO governance_proposals (id, manager_id, kind, status, incident, payload_json, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
      .run(row.id, row.manager_id, row.kind, row.incident, row.payload_json, row.created_at);
    this.db.prepare('DELETE FROM governance_waiting_proposals WHERE id = ?').run(row.id);
    return row.id;
  }

  /** Erases a waiting proposal of this manager; false when it has none with that id (another manager's id reads the same). */
  deleteOf({ managerId, id }: { managerId: string; id: string }): boolean {
    const { changes } = this.db.prepare('DELETE FROM governance_waiting_proposals WHERE id = ? AND manager_id = ?').run(id, managerId);
    return changes === 1;
  }
}
