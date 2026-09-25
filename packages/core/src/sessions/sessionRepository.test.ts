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

  it('does nothing when updating the model of an unknown session', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    expect(() => repo.setModel('nope', 'claude-opus-5-5')).not.toThrow();

    expect(repo.get('s1')!.model).toBeUndefined();
  });

  it('returns permissionMode for every session in list(), not just get()', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, permission_mode: 'plan' });

    const [session] = repo.list();

    expect(session!.permissionMode).toBe('plan');
  });

  it('reads back whatever string was stored, even one outside the known permission modes', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, permission_mode: 'not-a-real-mode' as never });

    expect(repo.get('s1')!.permissionMode).toBe('not-a-real-mode');
  });

  it('rotates the hook and mcp tokens, replacing the ones set at creation', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    repo.setTokens('s1', 'fresh-hook', 'fresh-mcp');

    expect(repo.tokens('s1')).toEqual({ hookToken: 'fresh-hook', mcpToken: 'fresh-mcp' });
    expect(repo.byHookToken('h')).toBeUndefined();
    expect(repo.byMcpToken('m')).toBeUndefined();
    expect(repo.byHookToken('fresh-hook')?.id).toBe('s1');
  });
});
