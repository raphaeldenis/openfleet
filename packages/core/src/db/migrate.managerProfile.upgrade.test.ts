import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagerRepository } from '../managers/managerRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { applyMigrations } from './migrate.js';

const directory = new URL('./migrations/', import.meta.url);
const beforeProfile = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '035_manager_profile.sql').sort()
  .map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
const tempDirs = createTempDirTracker();
afterEach(() => { vi.restoreAllMocks(); tempDirs.removeAll(); });

describe('the manager profile upgrade', () => {
  it('preserves an existing manager on disk and reads nullable fields as an empty profile at revision one', () => {
    const path = join(tempDirs.make('of-profile-upgrade-'), 'openfleet.db');
    const old = new DatabaseSync(path);
    applyMigrations(old, beforeProfile);
    old.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at)
      VALUES ('lead', 'Lead', '/tmp', 'fake', 'idle', 't0', 'hook', 'mcp', 't0')`).run();
    old.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES ('lead', 600, 4, 'Keep shipping', 't0')").run();
    old.close();

    const upgraded = new DatabaseSync(path);
    try {
      applyMigrations(upgraded);

      expect(new ManagerRepository(upgraded).get('lead')).toMatchObject({
        missionText: 'Keep shipping', pulseSeconds: 600, childrenCap: 4, expertise: '', pulseActions: [], profileRev: 1,
      });
      expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (const invalidActions of ['{broken', '{}', '[""]', '["same","same"]', '[42]', JSON.stringify(['a'.repeat(281)])]) {
        upgraded.prepare("UPDATE managers SET pulse_actions = ? WHERE session_id = 'lead'").run(invalidActions);
        expect(new ManagerRepository(upgraded).get('lead')?.pulseActions).toEqual([]);
      }
      expect(warn).toHaveBeenCalled();
    } finally { upgraded.close(); }
  });
});
