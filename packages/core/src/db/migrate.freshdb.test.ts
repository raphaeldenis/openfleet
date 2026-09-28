import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

describe('migrations on a fresh database', () => {
  it('apply cleanly, in order, with no error', () => {
    const db = new DatabaseSync(':memory:');

    expect(() => applyMigrations(db)).not.toThrow();
  });

  it('record every migration file as applied', () => {
    const db = new DatabaseSync(':memory:');
    const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql'));

    applyMigrations(db);

    const appliedVersions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);
    expect(appliedVersions.sort()).toEqual(migrationFileNames.map((fileName) => fileName.replace(/\.sql$/, '')).sort());
  });

  it('are numbered NNN_<subject>.sql from 001 with no gap', () => {
    const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql'));

    const isNumberedFile = (fileName: string) => /^\d{3}_.+\.sql$/.test(fileName);
    const migrationNumbers = migrationFileNames.map((fileName) => Number(fileName.slice(0, 3))).sort((a, b) => a - b);
    const expectedNumbers = migrationNumbers.map((_, index) => index + 1);

    expect(migrationFileNames.every(isNumberedFile)).toBe(true);
    expect(migrationNumbers).toEqual(expectedNumbers);
  });
});
