import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const permissionDenied = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  return {
    ...actual,
    fchmodSync: () => { throw permissionDenied(); },
  };
});

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const versions = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => f.replace(/\.sql$/, ''));

describe('a backup whose config copy cannot be secured', () => {
  it('refuses the boot and leaves no file of that backup behind, in particular no config copy at the source mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-backup-faults-'));
    const dbPath = join(home, 'openfleet.db');
    writeFileSync(join(home, 'config.json'), '{"secret":"synthetic"}', { mode: 0o644 });
    const db = new DatabaseSync(dbPath);
    applyMigrations(db, versions.slice(0, -1).map((version) => ({ version, sql: readFileSync(join(migrationsDir, `${version}.sql`), 'utf8') })));
    db.close();

    expect(() => openDatabase(dbPath)).toThrow(/backup/i);

    expect(readdirSync(join(home, 'backups'))).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
  });
});
