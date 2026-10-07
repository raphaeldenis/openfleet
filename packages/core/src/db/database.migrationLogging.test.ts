import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { recentLogLines } from '../logger.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

const directories = createTempDirTracker();
afterEach(() => { directories.removeAll(); vi.restoreAllMocks(); });

it.each(['default', 'silent'] as const)('preserves migration backups with %s logging', (logging) => {
  const home = directories.make('knowledge-migration-log-');
  const path = join(home, 'openfleet.db');
  const previous = new DatabaseSync(path);
  applyMigrations(previous, [{ version: '001_init', sql: readFileSync(new URL('./migrations/001_init.sql', import.meta.url), 'utf8') }]);
  previous.close();
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const logCount = recentLogLines().length;

  const db = logging === 'default' ? openDatabase(path) : openDatabase(path, { migrationLogging: 'silent' });
  db.close();

  const records = recentLogLines().slice(logCount);
  if (logging === 'silent') {
    expect(records).toEqual([]);
    expect(output).not.toHaveBeenCalled();
    return;
  }
  expect(records).toHaveLength(1);
  expect(JSON.parse(records[0]!).msg).toMatch(/^database backed up to .* before migrating$/);
  expect(output).toHaveBeenCalledTimes(1);
});
