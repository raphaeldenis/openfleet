import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotSqliteDatabase } from './sqliteSnapshot.js';

describe('snapshotSqliteDatabase', () => {
  let workDir: string;
  let sourcePath: string;
  let writer: DatabaseSync | undefined;
  const countIn = (path: string) => {
    const db = new DatabaseSync(path);
    try {
      return (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'openfleet-snapshot-'));
    sourcePath = join(workDir, 'source.db');
    writer = new DatabaseSync(sourcePath);
    writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);');
  });

  afterEach(() => writer?.close());

  it('holds the committed rows that only live in the WAL of a database a writer keeps open', () => {
    const targetPath = join(workDir, 'copy.db');

    snapshotSqliteDatabase({ sourcePath, targetPath });

    expect(countIn(targetPath)).toBe(2);
  });

  it('creates no file beside a source that has none of the WAL side files', () => {
    writer!.close();
    writer = undefined;
    const filesBefore = readdirSync(workDir).sort();

    snapshotSqliteDatabase({ sourcePath, targetPath: join(workDir, 'copy.db') });

    expect(readdirSync(workDir).filter((name) => name !== 'copy.db').sort()).toEqual(filesBefore);
  });
});
