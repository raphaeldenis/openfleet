import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { SessionRepository } from './sessionRepository.js';

describe('SessionRepository.closeAllOpen', () => {
  it('closes every session left in a non-closed state', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake', state: 'idle', state_since: 't', hook_token: 'h', mcp_token: 'm', permission_mode: null, created_at: 't' });

    repo.closeAllOpen(new Date().toISOString());

    expect(repo.get('s1')?.state).toBe('closed');
  });
});

const baseRow = { id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake' as const, state: 'starting' as const, state_since: 't0', hook_token: 'h', mcp_token: 'm', created_at: 't0', permission_mode: null };

describe('SessionRepository', () => {
  it('persists and returns permissionMode', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, permission_mode: 'default' });
    expect(repo.get('s1')!.permissionMode).toBe('default');
  });

  it('leaves permissionMode undefined when none was given', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);
    expect(repo.get('s1')!.permissionMode).toBeUndefined();
  });

  it('updates the model', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);
    repo.setModel('s1', 'claude-opus-5-5');
    expect(repo.get('s1')!.model).toBe('claude-opus-5-5');
  });
});
