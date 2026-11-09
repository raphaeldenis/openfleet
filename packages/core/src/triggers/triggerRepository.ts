import type { TriggerCondition, TriggerPolicy, TriggerRun, TriggerWhen } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';

export interface TriggerRecord {
  id: string;
  projectId: string;
  /** The manager (root of a lineage) whose children the trigger may watch, prompt and close; none means it may not prompt a session or close one. */
  ownerManagerId: string | null;
  title: string;
  when: TriggerWhen;
  conditions: TriggerCondition[];
  run: TriggerRun;
  policy: TriggerPolicy;
  contentRev: number;
  armedAt: string | null;
  approvedRev: number | null;
  approvedGraphDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What an edit replaces; every field it leaves out keeps its value. */
export type TriggerContent = Partial<Pick<TriggerRecord, 'title' | 'when' | 'conditions' | 'run' | 'policy' | 'ownerManagerId'>>;

interface TriggerRow {
  id: string; project_id: string; owner_manager_id: string | null; title: string; when_json: string; conditions_json: string; run_json: string; policy_json: string;
  content_rev: number; armed_at: string | null; approved_rev: number | null; approved_graph_digest: string | null; created_at: string; updated_at: string;
}

const COLUMNS = 'id, project_id, owner_manager_id, title, when_json, conditions_json, run_json, policy_json, content_rev, armed_at, approved_rev, approved_graph_digest, created_at, updated_at';

const toRecord = (row: TriggerRow): TriggerRecord => ({
  id: row.id, projectId: row.project_id, ownerManagerId: row.owner_manager_id, title: row.title, when: JSON.parse(row.when_json), conditions: JSON.parse(row.conditions_json),
  run: JSON.parse(row.run_json), policy: JSON.parse(row.policy_json), contentRev: row.content_rev, armedAt: row.armed_at,
  approvedRev: row.approved_rev, approvedGraphDigest: row.approved_graph_digest, createdAt: row.created_at, updatedAt: row.updated_at,
});

export class TriggerRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(trigger: Pick<TriggerRecord, 'id' | 'projectId' | 'ownerManagerId' | 'title' | 'when' | 'conditions' | 'run' | 'policy' | 'createdAt'>): void {
    this.db.prepare(`INSERT INTO triggers (id, project_id, owner_manager_id, title, when_json, conditions_json, run_json, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(trigger.id, trigger.projectId, trigger.ownerManagerId, trigger.title, JSON.stringify(trigger.when), JSON.stringify(trigger.conditions), JSON.stringify(trigger.run), JSON.stringify(trigger.policy), trigger.createdAt, trigger.createdAt);
  }

  get(id: string): TriggerRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM triggers WHERE id = ?`).get(id) as TriggerRow | undefined;
    return row && toRecord(row);
  }

  /** The triggers of a project, oldest first. */
  listOfProject(projectId: string): TriggerRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM triggers WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as unknown as TriggerRow[];
    return rows.map(toRecord);
  }

  /** Every trigger a human armed, oldest first. */
  listArmed(): TriggerRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM triggers WHERE armed_at IS NOT NULL ORDER BY created_at, id`).all() as unknown as TriggerRow[];
    return rows.map(toRecord);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id).changes) > 0;
  }

  /** Replaces the content when the revision is still `expectedRev`, bumps the revision and clears the arming; false when the revision moved. */
  replaceContent(input: { id: string; expectedRev: number; content: TriggerContent; now: string }): boolean {
    const { id, expectedRev, content, now } = input;
    const isChangingTheOwner = content.ownerManagerId !== undefined;
    const result = this.db.prepare(`UPDATE triggers SET
        title = COALESCE(?, title), when_json = COALESCE(?, when_json), conditions_json = COALESCE(?, conditions_json),
        run_json = COALESCE(?, run_json), policy_json = COALESCE(?, policy_json),
        owner_manager_id = CASE WHEN ? THEN ? ELSE owner_manager_id END,
        content_rev = content_rev + 1, armed_at = NULL, approved_rev = NULL, approved_graph_digest = NULL, updated_at = ?
      WHERE id = ? AND content_rev = ?`)
      .run(content.title ?? null, json(content.when), json(content.conditions), json(content.run), json(content.policy), isChangingTheOwner ? 1 : 0, content.ownerManagerId ?? null, now, id, expectedRev);
    return Number(result.changes) > 0;
  }

  /** Records the arming when the revision is still `approvedRev`; false when the revision moved. */
  arm(input: { id: string; approvedRev: number; approvedGraphDigest: string; now: string }): boolean {
    const result = this.db.prepare('UPDATE triggers SET armed_at = ?, approved_rev = ?, approved_graph_digest = ? WHERE id = ? AND content_rev = ?')
      .run(input.now, input.approvedRev, input.approvedGraphDigest, input.id, input.approvedRev);
    return Number(result.changes) > 0;
  }

  disarm(id: string): void {
    this.db.prepare('UPDATE triggers SET armed_at = NULL, approved_rev = NULL, approved_graph_digest = NULL WHERE id = ?').run(id);
  }

  /**
   * Clears the arming of every armed trigger whose RUN starts the playbook, and bumps their revision so that a review made before the change cannot arm them again.
   * Returns the ids it disarmed; the fires of those triggers stay.
   */
  disarmThoseRunningPlaybook(playbookId: string): string[] {
    const disarmed = this.db.prepare(`UPDATE triggers SET armed_at = NULL, approved_rev = NULL, approved_graph_digest = NULL, content_rev = content_rev + 1
      WHERE armed_at IS NOT NULL AND json_extract(run_json, '$.playbookId') = ? RETURNING id`).all(playbookId) as unknown as { id: string }[];
    return disarmed.map(({ id }) => id);
  }
}

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
