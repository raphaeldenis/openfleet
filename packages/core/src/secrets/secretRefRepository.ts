import type { DatabaseSync } from 'node:sqlite';
import type { SecretScope, SecretStatus } from '@openfleet/shared';
import { newId } from '../ids.js';

export interface SecretRef {
  name: string;
  status: SecretStatus;
  setAt?: string;
  setBy?: string;
}

interface SecretRefRow { name: string; status: SecretStatus; set_at: string | null; set_by: string | null }

const toSecretRef = (row: SecretRefRow): SecretRef => ({
  name: row.name, status: row.status,
  ...(row.set_at !== null && { setAt: row.set_at }),
  ...(row.set_by !== null && { setBy: row.set_by }),
});

/** The metadata of secrets: which names a scope declares and whether this device holds a value. A value is never written here. */
export class SecretRefRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Declares a name under a scope as missing; declaring it again changes nothing. */
  declare(scope: SecretScope, name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES (?, ?, ?, ?, 'missing')").run(newId(), scope.kind, scope.id, name);
  }

  /** Removes the declaration of a name that holds no value; a name with a stored value stays, so a human can still clear it. */
  undeclareWhenMissing(scope: SecretScope, name: string): void {
    this.db.prepare("DELETE FROM secret_refs WHERE scope_kind = ? AND scope_id = ? AND name = ? AND status = 'missing'").run(scope.kind, scope.id, name);
  }

  isScopeKnown(scope: SecretScope): boolean {
    return this.db.prepare('SELECT 1 AS known FROM secret_refs WHERE scope_kind = ? AND scope_id = ? LIMIT 1').get(scope.kind, scope.id) !== undefined;
  }

  find(scope: SecretScope, name: string): SecretRef | undefined {
    const row = this.db.prepare('SELECT name, status, set_at, set_by FROM secret_refs WHERE scope_kind = ? AND scope_id = ? AND name = ?').get(scope.kind, scope.id, name) as SecretRefRow | undefined;
    return row === undefined ? undefined : toSecretRef(row);
  }

  listOf(scope: SecretScope): SecretRef[] {
    const rows = this.db.prepare('SELECT name, status, set_at, set_by FROM secret_refs WHERE scope_kind = ? AND scope_id = ? ORDER BY name').all(scope.kind, scope.id) as unknown as SecretRefRow[];
    return rows.map(toSecretRef);
  }

  markStored(scope: SecretScope, name: string, { at, by }: { at: string; by: string }): void {
    this.db.prepare("UPDATE secret_refs SET status = 'stored', set_at = ?, set_by = ? WHERE scope_kind = ? AND scope_id = ? AND name = ?").run(at, by, scope.kind, scope.id, name);
  }

  markMissing(scope: SecretScope, name: string): void {
    this.db.prepare("UPDATE secret_refs SET status = 'missing', set_at = NULL, set_by = NULL WHERE scope_kind = ? AND scope_id = ? AND name = ?").run(scope.kind, scope.id, name);
  }
}
