import type { PlaybookFlow, PlaybookInputDeclaration, PlaybookOrigin, PlaybookPolicy } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';

export interface PlaybookRecord {
  id: string;
  projectId: string;
  name: string;
  inputs: PlaybookInputDeclaration[];
  flow: PlaybookFlow;
  contentRev: number;
  agentLocked: boolean;
  policy: PlaybookPolicy;
  approvedDigest: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  origin: PlaybookOrigin;
  createdAt: string;
  updatedAt: string;
}

/** What an edit replaces; every field it leaves out keeps its value. */
export type PlaybookContent = Partial<Pick<PlaybookRecord, 'name' | 'inputs' | 'flow' | 'policy' | 'agentLocked'>>;

interface PlaybookRow {
  id: string; project_id: string; name: string; inputs_json: string; flow_json: string; content_rev: number; agent_locked: number; policy_json: string;
  approved_digest: string | null; approved_by: string | null; approved_at: string | null; origin: PlaybookOrigin; created_at: string; updated_at: string;
}

const COLUMNS = 'id, project_id, name, inputs_json, flow_json, content_rev, agent_locked, policy_json, approved_digest, approved_by, approved_at, origin, created_at, updated_at';

const toRecord = (row: PlaybookRow): PlaybookRecord => ({
  id: row.id, projectId: row.project_id, name: row.name, inputs: JSON.parse(row.inputs_json), flow: JSON.parse(row.flow_json), contentRev: row.content_rev,
  agentLocked: row.agent_locked === 1, policy: JSON.parse(row.policy_json), approvedDigest: row.approved_digest, approvedBy: row.approved_by,
  approvedAt: row.approved_at, origin: row.origin, createdAt: row.created_at, updatedAt: row.updated_at,
});

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
const flag = (value: boolean | undefined): number | null => (value === undefined ? null : Number(value));

export class PlaybookRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(playbook: Pick<PlaybookRecord, 'id' | 'projectId' | 'name' | 'inputs' | 'flow' | 'policy' | 'agentLocked' | 'origin' | 'createdAt'>): void {
    this.db.prepare(`INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, agent_locked, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(playbook.id, playbook.projectId, playbook.name, JSON.stringify(playbook.inputs), JSON.stringify(playbook.flow), JSON.stringify(playbook.policy), Number(playbook.agentLocked), playbook.origin, playbook.createdAt, playbook.createdAt);
  }

  get(id: string): PlaybookRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM playbooks WHERE id = ?`).get(id) as PlaybookRow | undefined;
    return row && toRecord(row);
  }

  /** The playbooks of a project, oldest first. */
  listOfProject(projectId: string): PlaybookRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM playbooks WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as unknown as PlaybookRow[];
    return rows.map(toRecord);
  }

  /** Deletes the playbook when the revision is still `expectedRev`; false when it moved or the playbook is gone. */
  delete(input: { id: string; expectedRev: number }): boolean {
    return Number(this.db.prepare('DELETE FROM playbooks WHERE id = ? AND content_rev = ?').run(input.id, input.expectedRev).changes) > 0;
  }

  /** Replaces the content when the revision is still `expectedRev`, bumps the revision and clears any approval; false when the revision moved. */
  replaceContent(input: { id: string; expectedRev: number; content: PlaybookContent; now: string }): boolean {
    const { id, expectedRev, content, now } = input;
    const result = this.db.prepare(`UPDATE playbooks SET
        name = COALESCE(?, name), inputs_json = COALESCE(?, inputs_json), flow_json = COALESCE(?, flow_json),
        policy_json = COALESCE(?, policy_json), agent_locked = COALESCE(?, agent_locked),
        content_rev = content_rev + 1, approved_digest = NULL, approved_by = NULL, approved_at = NULL, updated_at = ?
      WHERE id = ? AND content_rev = ?`)
      .run(content.name ?? null, json(content.inputs), json(content.flow), json(content.policy), flag(content.agentLocked), now, id, expectedRev);
    return Number(result.changes) > 0;
  }
}
