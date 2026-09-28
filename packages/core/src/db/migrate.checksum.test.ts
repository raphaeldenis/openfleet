import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const checksumMigrationFileName = migrationFileNames.find((fileName) => fileName.endsWith('_schema_migrations_checksum.sql'))!;
const migrationsBeforeChecksumColumn = migrationFileNames
  .filter((fileName) => fileName < checksumMigrationFileName)
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('applyMigrations — refusing a database newer than this code', () => {
  it('refuses to start, naming the unknown version, when schema_migrations holds a version this checkout has no file for', () => {
    const db = openDatabase(':memory:');
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run('999_from_a_newer_branch', new Date().toISOString());

    expect(() => applyMigrations(db)).toThrow(/999_from_a_newer_branch/);
  });
});

describe('applyMigrations — per-file checksum', () => {
  it('backfills a checksum for every already-applied migration on an existing database that has none yet', () => {
    const db = openDatabase(':memory:');

    const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: string; checksum: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.checksum).not.toBeNull();
  });

  it('records the checksum of a freshly applied migration as the sha256 of its own SQL', () => {
    const db = openDatabase(':memory:');
    const migration = [{ version: '999_checksummed', sql: 'CREATE TABLE checksummed_probe (id TEXT) STRICT;' }];

    applyMigrations(db, migration);

    const row = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get('999_checksummed') as { checksum: string | null };
    expect(row.checksum).toBe(sha256Hex(migration[0]!.sql));
  });

  it('refuses to start when an already-applied migration file was edited after the fact, naming the version', () => {
    const db = openDatabase(':memory:');
    const anyAppliedVersion = (db.prepare('SELECT version FROM schema_migrations LIMIT 1').get() as { version: string }).version;

    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('not-the-real-checksum', anyAppliedVersion);

    expect(() => applyMigrations(db)).toThrow(new RegExp(anyAppliedVersion));
  });

  it('does not fail startup for a database that predates the checksum column at all, and backfills it on that first run', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeChecksumColumn);
    const beforeUpgrade = db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[];
    expect(beforeUpgrade.length).toBeGreaterThan(0);

    expect(() => applyMigrations(db)).not.toThrow();

    const rows = db.prepare('SELECT checksum FROM schema_migrations').all() as { checksum: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.checksum).not.toBeNull();
  });
});
