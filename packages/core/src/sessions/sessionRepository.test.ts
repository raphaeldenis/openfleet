import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { SessionRepository } from './sessionRepository.js';

describe('SessionRepository.closeAllOpen', () => {
  it('closes every session left in a non-closed state', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake', state: 'idle', state_since: 't', hook_token: 'h', mcp_token: 'm', created_at: 't' });

    repo.closeAllOpen(new Date().toISOString());

    expect(repo.get('s1')?.state).toBe('closed');
  });
});
