import type { PlaybookFlow, PlaybookInputDeclaration, PlaybookPolicy, PlaybookVersionSource } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';

/** The content a version holds: what an edit replaces, never the lock and never a secret value (a secret appears as its `{{secret:NAME}}` token). */
export interface PlaybookVersion {
  playbookId: string;
  rev: number;
  name: string;
  inputs: PlaybookInputDeclaration[];
  flow: PlaybookFlow;
  policy: PlaybookPolicy;
  sha256: string;
  source: PlaybookVersionSource;
  approvedDigest: string | null;
  createdAt: string;
}

interface VersionRow {
  playbook_id: string; rev: number; name: string; inputs_json: string; flow_json: string; policy_json: string;
  sha256: string; source: PlaybookVersionSource; approved_digest: string | null; created_at: string;
}

const COLUMNS = 'playbook_id, rev, name, inputs_json, flow_json, policy_json, sha256, source, approved_digest, created_at';

const toVersion = (row: VersionRow): PlaybookVersion => ({
  playbookId: row.playbook_id, rev: row.rev, name: row.name, inputs: JSON.parse(row.inputs_json), flow: JSON.parse(row.flow_json), policy: JSON.parse(row.policy_json),
  sha256: row.sha256, source: row.source, approvedDigest: row.approved_digest, createdAt: row.created_at,
});

export class PlaybookVersionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(version: PlaybookVersion): void {
    this.db.prepare(`INSERT INTO playbook_versions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(version.playbookId, version.rev, version.name, JSON.stringify(version.inputs), JSON.stringify(version.flow), JSON.stringify(version.policy), version.sha256, version.source, version.approvedDigest, version.createdAt);
  }

  get(playbookId: string, rev: number): PlaybookVersion | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM playbook_versions WHERE playbook_id = ? AND rev = ?`).get(playbookId, rev) as VersionRow | undefined;
    return row && toVersion(row);
  }

  /** The versions of a playbook, newest first. */
  listOf(playbookId: string): PlaybookVersion[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM playbook_versions WHERE playbook_id = ? ORDER BY rev DESC`).all(playbookId) as unknown as VersionRow[];
    return rows.map(toVersion);
  }

  /** Drops the oldest versions until at most `cap` remain; the newest version that was approved is never dropped. */
  purgeOldestBeyond(playbookId: string, cap: number): void {
    this.db.prepare(`DELETE FROM playbook_versions WHERE playbook_id = ? AND rev IN (
        SELECT rev FROM playbook_versions
        WHERE playbook_id = ?
          AND rev <> COALESCE((SELECT MAX(rev) FROM playbook_versions WHERE playbook_id = ? AND approved_digest IS NOT NULL), -1)
        ORDER BY rev ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM playbook_versions WHERE playbook_id = ?) - ?))`)
      .run(playbookId, playbookId, playbookId, playbookId, cap);
  }
}
