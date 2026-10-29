import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { WatchedPrRepository } from './watchedPrRepository.js';

const migrationsDownDirectory = new URL('../db/migrations-down/', import.meta.url);

const openDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
};

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

const pullRequest = { repo: 'acme/widgets', number: 7 };

describe('the watched pull request repository', () => {
  it('lists a watched pull request as active with no notified sha and no error', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const repository = new WatchedPrRepository(db);

    repository.watch({ managerId: 'lead', ...pullRequest });

    expect(repository.activeOf('lead')).toEqual([expect.objectContaining({ managerId: 'lead', ...pullRequest, status: 'active' })]);
    expect(repository.activeOf('lead')[0]).not.toHaveProperty('lastNotifiedSha');
    expect(repository.activeOf('lead')[0]).not.toHaveProperty('lastErrorCode');
  });

  it('watches the same pull request once for a manager', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const repository = new WatchedPrRepository(db);

    repository.watch({ managerId: 'lead', ...pullRequest });
    repository.watch({ managerId: 'lead', ...pullRequest });

    expect(repository.countActiveOf('lead')).toBe(1);
  });

  it('stops listing a pull request once it is closed, and counts it no more against the cap', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const repository = new WatchedPrRepository(db);
    const watched = repository.watch({ managerId: 'lead', ...pullRequest });

    repository.close(watched.id);

    expect(repository.activeOf('lead')).toEqual([]);
    expect(repository.countActiveOf('lead')).toBe(0);
  });

  it('reactivates a closed pull request when the manager watches it again', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const repository = new WatchedPrRepository(db);
    const watched = repository.watch({ managerId: 'lead', ...pullRequest });
    repository.close(watched.id);

    repository.watch({ managerId: 'lead', ...pullRequest });

    expect(repository.countActiveOf('lead')).toBe(1);
  });

  it('forgets a pull request on unwatch and says whether it was watched', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const repository = new WatchedPrRepository(db);
    repository.watch({ managerId: 'lead', ...pullRequest });

    const wasWatched = repository.unwatch({ managerId: 'lead', ...pullRequest });
    const wasWatchedTwice = repository.unwatch({ managerId: 'lead', ...pullRequest });

    expect([wasWatched, wasWatchedTwice]).toEqual([true, false]);
    expect(repository.activeOf('lead')).toEqual([]);
  });

  it('remembers the last notified sha and the last error after the database is reopened', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const watched = new WatchedPrRepository(db).watch({ managerId: 'lead', ...pullRequest });
    new WatchedPrRepository(db).recordNotified(watched.id, 'a'.repeat(40));
    new WatchedPrRepository(db).recordError(watched.id, 'gh_timeout');

    const [reopened] = new WatchedPrRepository(db).activeOf('lead');

    expect(reopened).toEqual(expect.objectContaining({ lastNotifiedSha: 'a'.repeat(40), lastErrorCode: 'gh_timeout' }));
  });

  it('clears the last error when a poll succeeds', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    const repository = new WatchedPrRepository(db);
    const watched = repository.watch({ managerId: 'lead', ...pullRequest });
    repository.recordError(watched.id, 'gh_timeout');

    repository.recordError(watched.id, undefined);

    expect(repository.activeOf('lead')[0]).not.toHaveProperty('lastErrorCode');
  });

  it('lists every manager that watches an active pull request', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    insertManager(db, 'other');
    const repository = new WatchedPrRepository(db);
    repository.watch({ managerId: 'lead', ...pullRequest });
    repository.watch({ managerId: 'other', repo: 'acme/widgets', number: 8 });

    expect(repository.allActive().map((watched) => watched.managerId).sort()).toEqual(['lead', 'other']);
  });

  it('drops the watched pull requests of a manager when the manager is deleted', () => {
    const db = openDatabase();
    insertManager(db, 'lead');
    new WatchedPrRepository(db).watch({ managerId: 'lead', ...pullRequest });

    db.prepare("DELETE FROM managers WHERE session_id = 'lead'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM watched_prs').get()).toEqual({ n: 0 });
  });

  it('refuses a status outside active and closed', () => {
    const db = openDatabase();
    insertManager(db, 'lead');

    const insertBadStatus = () => db.prepare("INSERT INTO watched_prs (id, manager_id, repo, number, status, created_at) VALUES ('x', 'lead', 'a/b', 1, 'paused', 't0')").run();

    expect(insertBadStatus).toThrow();
  });

  it('ships a down migration outside the migrations folder that removes the table', () => {
    const db = openDatabase();

    db.exec(readFileSync(new URL('052_watched_prs.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'watched_prs'").get()).toBeUndefined();
  });
});
