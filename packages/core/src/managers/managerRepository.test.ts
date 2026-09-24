import { describe, expect, it } from 'vitest';
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
});
