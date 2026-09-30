import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailableError } from './databaseFailure.js';

const isRoot = process.getuid?.() === 0;
const sqliteError = (errcode: number) => Object.assign(new Error('sqlite says no'), { code: 'ERR_SQLITE_ERROR', errcode });

describe('isDatabaseUnavailableError', () => {
  it.each([
    ['SQLITE_PERM', 3], ['SQLITE_READONLY', 8], ['SQLITE_IOERR', 10], ['SQLITE_FULL', 13], ['SQLITE_CANTOPEN', 14],
    ['SQLITE_CORRUPT', 11], ['SQLITE_NOTADB', 26], ['SQLITE_CORRUPT_VTAB', 267],
  ])('recognises %s: the database cannot take writes', (_name, errcode) => {
    expect(isDatabaseUnavailableError(sqliteError(errcode))).toBe(true);
  });

  it.each([
    ['SQLITE_IOERR_WRITE', 778], ['SQLITE_READONLY_DBMOVED', 1032], ['SQLITE_CANTOPEN_NOTEMPDIR', 270],
  ])('recognises the extended code %s through its primary code', (_name, errcode) => {
    expect(isDatabaseUnavailableError(sqliteError(errcode))).toBe(true);
  });

  it.each([
    ['SQLITE_CONSTRAINT', 19], ['SQLITE_BUSY', 5], ['SQLITE_ERROR', 1],
  ])('does not take %s for an unavailable database: the caller did something wrong or waits', (_name, errcode) => {
    expect(isDatabaseUnavailableError(sqliteError(errcode))).toBe(false);
  });

  it.each([
    ['a plain Error', new Error('disk I/O error')], ['undefined', undefined], ['a string', 'SQLITE_IOERR'], ['null', null],
    ['a non-numeric errcode', Object.assign(new Error('x'), { errcode: '10' })],
  ])('does not take %s for one', (_name, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(false);
  });

  it('survives an error whose errcode getter throws', () => {
    const hostile = Object.defineProperty(new Error('x'), 'errcode', { get() { throw new Error('getter'); } });

    expect(isDatabaseUnavailableError(hostile)).toBe(false);
  });

  it.skipIf(isRoot)('recognises the real error of a database file the daemon may not open (chmod 000)', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-dbfail-'));
    const path = join(home, 'openfleet.db');
    new DatabaseSync(path).close();
    chmodSync(path, 0o000);
    try {
      let thrown: unknown;
      try { new DatabaseSync(path).exec('SELECT 1'); } catch (error) { thrown = error; }

      expect(thrown).toBeDefined();
      expect(isDatabaseUnavailableError(thrown)).toBe(true);
    } finally {
      chmodSync(path, 0o600);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
