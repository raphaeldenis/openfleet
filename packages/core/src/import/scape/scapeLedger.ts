import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EntityName } from './importReport.js';

export const LEDGER_KINDS = ['project', 'note', 'note_version', 'playbook_archive', 'data_store', 'column', 'view', 'row', 'history', 'manager', 'working_state', 'memory_file'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const ENTITY_OF_LEDGER_KIND: Record<LedgerKind, EntityName> = {
  project: 'projects', note: 'notes', note_version: 'noteVersions', playbook_archive: 'playbooks', data_store: 'dataStores',
  column: 'columns', view: 'views', row: 'rows', history: 'history', manager: 'managers', working_state: 'workingStates', memory_file: 'memories',
};

type HashableValue = string | number | null;

/** The same values always give the same hash, whatever the order of the keys. */
export function hashOfValues(values: Record<string, HashableValue>): string {
  const sortedEntries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex');
}

export const withoutColumns = <T extends Record<string, HashableValue>>(values: T, ignoredColumns: readonly string[]): Record<string, HashableValue> =>
  Object.fromEntries(Object.entries(values).filter(([column]) => !ignoredColumns.includes(column)));

/** What the last import wrote, per entity: the hash of the source record. It is the common ancestor of the 3-way compare on a re-import. */
export class ImportLedger {
  constructor(private readonly db: DatabaseSync) {}

  hashOf(kind: LedgerKind, id: string): string | undefined {
    const entry = this.db.prepare('SELECT record_hash FROM scape_import_ledger WHERE kind = ? AND id = ?').get(kind, id) as { record_hash: string } | undefined;
    return entry?.record_hash;
  }

  /** Writes nothing when the entry already holds this hash, so a run that changes nothing leaves the database file as it is. */
  remember(input: { kind: LedgerKind; id: string; hash: string }): void {
    if (this.hashOf(input.kind, input.id) === input.hash) return;
    this.db
      .prepare(`INSERT INTO scape_import_ledger (kind, id, record_hash, imported_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (kind, id) DO UPDATE SET record_hash = excluded.record_hash, imported_at = excluded.imported_at`)
      .run(input.kind, input.id, input.hash, new Date().toISOString());
  }

  forget(kind: LedgerKind, id: string): void {
    this.db.prepare('DELETE FROM scape_import_ledger WHERE kind = ? AND id = ?').run(kind, id);
  }

  idsOf(kind: LedgerKind): string[] {
    return (this.db.prepare('SELECT id FROM scape_import_ledger WHERE kind = ?').all(kind) as { id: string }[]).map((entry) => entry.id);
  }
}
