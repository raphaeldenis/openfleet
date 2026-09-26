import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ManagerRepository } from './managerRepository.js';

function insertSession(db: ReturnType<typeof openDatabase>, id: string): void {
  db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES (?, 'Lead', '/tmp', 'fake', 'idle', 't', ?, ?, 't')`)
    .run(id, `hook-${id}`, `mcp-${id}`);
}

describe('ManagerRepository', () => {
  it('inserts and reads back a manager record', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    const repo = new ManagerRepository(db);
    repo.insert({ sessionId: 's1', pulseSeconds: 1800, childrenCap: 2, missionText: 'Ship it', createdAt: 't0' });
    expect(repo.get('s1')).toEqual({ sessionId: 's1', pulseSeconds: 1800, childrenCap: 2, missionText: 'Ship it', lastPulseAt: undefined, createdAt: 't0' });
  });

  it('returns undefined for a session with no manager record', () => {
    const db = openDatabase(':memory:');
    expect(new ManagerRepository(db).get('nope')).toBeUndefined();
  });

  it('lists every manager record', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    insertSession(db, 's2');
    const repo = new ManagerRepository(db);
    repo.insert({ sessionId: 's1', pulseSeconds: 60, childrenCap: 1, missionText: 'a', createdAt: 't0' });
    repo.insert({ sessionId: 's2', pulseSeconds: 60, childrenCap: 1, missionText: 'b', createdAt: 't0' });
    expect(repo.list().map((m) => m.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('records the last pulse time', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    const repo = new ManagerRepository(db);
    repo.insert({ sessionId: 's1', pulseSeconds: 60, childrenCap: 1, missionText: 'a', createdAt: 't0' });
    repo.setLastPulseAt('s1', 't1');
    expect(repo.get('s1')!.lastPulseAt).toBe('t1');
  });

  it('returns an empty array when no manager exists', () => {
    const db = openDatabase(':memory:');
    expect(new ManagerRepository(db).list()).toEqual([]);
  });

  it('rejects a manager record for a session that does not exist', () => {
    const db = openDatabase(':memory:');
    const repo = new ManagerRepository(db);
    expect(() => repo.insert({ sessionId: 'ghost', pulseSeconds: 60, childrenCap: 1, missionText: 'a', createdAt: 't0' })).toThrow();
  });

  it('rejects a second manager record for the same session', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    const repo = new ManagerRepository(db);
    repo.insert({ sessionId: 's1', pulseSeconds: 60, childrenCap: 1, missionText: 'a', createdAt: 't0' });
    expect(() => repo.insert({ sessionId: 's1', pulseSeconds: 90, childrenCap: 2, missionText: 'b', createdAt: 't1' })).toThrow();
  });

  it('rejects a non-numeric pulse_seconds under the STRICT table', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    const repo = new ManagerRepository(db);
    expect(() =>
      repo.insert({ sessionId: 's1', pulseSeconds: 'soon' as never, childrenCap: 1, missionText: 'a', createdAt: 't0' }),
    ).toThrow();
  });

  it('rejects a fractional pulse_seconds under the STRICT table', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    const repo = new ManagerRepository(db);
    expect(() =>
      repo.insert({ sessionId: 's1', pulseSeconds: 1.5 as never, childrenCap: 1, missionText: 'a', createdAt: 't0' }),
    ).toThrow();
  });

  it('does nothing when setting the last pulse time on an unknown session', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 's1');
    const repo = new ManagerRepository(db);
    repo.insert({ sessionId: 's1', pulseSeconds: 60, childrenCap: 1, missionText: 'a', createdAt: 't0' });

    expect(() => repo.setLastPulseAt('nope', 't1')).not.toThrow();

    expect(repo.get('s1')!.lastPulseAt).toBeUndefined();
  });

  it('skips a stored row outside the schema bounds on list(), warning once with its session id, and keeps every valid manager working', () => {
    const db = openDatabase(':memory:');
    insertSession(db, 'good');
    insertSession(db, 'poisoned');
    const repo = new ManagerRepository(db);
    repo.insert({ sessionId: 'good', pulseSeconds: 60, childrenCap: 1, missionText: 'a', createdAt: 't0' });
    // Bypasses the app-level ManagerSpecSchema the way a hand-edited row or an older schema version would.
    repo.insert({ sessionId: 'poisoned', pulseSeconds: 9000000000000, childrenCap: 0, missionText: 'x', createdAt: 't0' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const records = repo.list();

    expect(records.map((m) => m.sessionId)).toEqual(['good']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('poisoned'));
    warnSpy.mockRestore();
  });
});
