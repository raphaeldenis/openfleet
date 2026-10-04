import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionRepository } from './sessionRepository.js';

describe('SessionRepository.closeAllOpen', () => {
  it('closes every session left in a non-closed state', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake', state: 'idle', state_since: 't', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, created_at: 't' });

    repo.closeAllOpen(new Date().toISOString());

    expect(repo.get('s1')?.state).toBe('closed');
  });
});

describe('SessionRepository.setContextNoticeTokens', () => {
  it('keeps the session list readable when handed a value beyond the safe integer range', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake', state: 'idle', state_since: 't', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, created_at: 't' });

    repo.setContextNoticeTokens('s1', 2 ** 60);

    expect(repo.list().map((session) => session.contextNoticeTokens)).toEqual([undefined]);
  });
});

describe('SessionRepository close reason', () => {
  const openRepository = () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake', state: 'idle', state_since: 't', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, created_at: 't' });
    return { db, repo };
  };

  it('stores the reason in the same write as the close', () => {
    const { repo } = openRepository();

    repo.setClosed('s1', 143, 't1', 'h2', 'm2', { closeReason: 'harness_exit' });

    expect(repo.get('s1')).toMatchObject({ state: 'closed', exitCode: 143, closeReason: 'harness_exit' });
  });

  it('leaves the reason absent for a close that gives none', () => {
    const { repo } = openRepository();

    repo.setClosed('s1', undefined, 't1', 'h2', 'm2');

    expect(repo.get('s1')?.closeReason).toBeUndefined();
  });

  it('drops the reason together with the exit code when the session starts again', () => {
    const { repo } = openRepository();
    repo.setClosed('s1', 1, 't1', 'h2', 'm2', { closeReason: 'harness_exit' });

    repo.setState('s1', 'starting', 't2');

    expect(repo.get('s1')?.closeReason).toBeUndefined();
  });

  it('keeps the reason while the row stays closed', () => {
    const { repo } = openRepository();
    repo.setClosed('s1', 1, 't1', 'h2', 'm2', { closeReason: 'harness_exit' });

    repo.setState('s1', 'closed', 't2');

    expect(repo.get('s1')?.closeReason).toBe('harness_exit');
  });

  it('rewrites the reason when a closed row is rewritten as a failed close', () => {
    const { repo } = openRepository();
    repo.setClosed('s1', undefined, 't1', 'h2', 'm2', { closeReason: 'daemon_shutdown', closedByDaemonShutdown: true });

    repo.failClosedRow('s1', 't2', { closeReason: 'launch_failed' });

    const row = repo.get('s1')!;
    expect(row.exitCode).toBeUndefined();
    expect(row.closeReason).toBe('launch_failed');
  });

  it('reads a reason written by a future version as absent instead of throwing, from get() and list()', () => {
    const { db, repo } = openRepository();
    repo.setClosed('s1', 1, 't1', 'h2', 'm2');
    db.prepare("UPDATE sessions SET close_reason = 'quota_exhausted' WHERE id = 's1'").run();

    expect(repo.get('s1')?.closeReason).toBeUndefined();
    expect(repo.list().map((session) => session.closeReason)).toEqual([undefined]);
  });
});

const currentCliSessionIdInRow =(db: ReturnType<typeof openDatabase>, id: string) =>
  (db.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get(id) as { cli_session_id: string | null }).cli_session_id;

describe('SessionRepository.setCliSessionId', () => {
  it('leaves the current conversation of the session untouched when reserving the id fails', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake', state: 'idle', state_since: 't', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, created_at: 't' });
    db.exec('DROP TABLE session_cli_ids');

    expect(() => repo.setCliSessionId('s1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toThrow();

    expect(currentCliSessionIdInRow(db, 's1')).toBeNull();
  });
});

const baseRow = { id: 's1', name: 'G', emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: null, role: null, harness: 'fake' as const, state: 'starting' as const, state_since: 't0', hook_token: 'h', mcp_token: 'm', created_at: 't0', permission_mode: null, branch: null };

describe('SessionRepository', () => {
  it('persists and returns permissionMode', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, permission_mode: 'plan' });
    expect(repo.get('s1')!.permissionMode).toBe('plan');
  });

  it('reads a legacy stored "default" permission_mode as "manual", both from get() and list()', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, permission_mode: 'default' });

    expect(repo.get('s1')!.permissionMode).toBe('manual');
    expect(repo.list()[0]!.permissionMode).toBe('manual');
  });

  it('reads an unrecognized stored permission_mode as undefined, both from get() and list()', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, permission_mode: 'bogus' });

    expect(repo.get('s1')!.permissionMode).toBeUndefined();
    expect(repo.list()[0]!.permissionMode).toBeUndefined();
  });

  it('persists and returns projectId, both from get() and list()', () => {
    const db = openDatabase(':memory:');
    new ProjectRepository(db).insert({ id: 'p1', name: 'OpenFleet', docsFolderPath: null, createdAt: 't0' });
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, project_id: 'p1' });

    expect(repo.get('s1')!.projectId).toBe('p1');
    expect(repo.list()[0]!.projectId).toBe('p1');
  });

  it('leaves projectId undefined when the session belongs to no project', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    expect(repo.get('s1')!.projectId).toBeUndefined();
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

  it('does not match a closed session\'s token by lookup, even a row this build never touched (a pre-patch upgrade row)', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, state: 'closed', hook_token: 'legacy-hook', mcp_token: 'legacy-mcp' });

    expect(repo.byHookToken('legacy-hook')).toBeUndefined();
    expect(repo.byMcpToken('legacy-mcp')).toBeUndefined();
  });

  it('closes the session and rotates both tokens in a single write', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    repo.setClosed('s1', 0, 't1', 'fresh-hook', 'fresh-mcp');

    const session = repo.get('s1')!;
    expect(session.state).toBe('closed');
    expect(session.exitCode).toBe(0);
    expect(repo.tokens('s1')).toEqual({ hookToken: 'fresh-hook', mcpToken: 'fresh-mcp' });
    expect(repo.byHookToken('h')).toBeUndefined();
    expect(repo.byMcpToken('m')).toBeUndefined();
  });

  it('persists and returns the worktree branch a session was created on', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert({ ...baseRow, branch: 'phase2/task-12-session-lifecycle-routes' });
    expect(repo.get('s1')!.branch).toBe('phase2/task-12-session-lifecycle-routes');
  });

  it('leaves branch undefined for a session created outside a worktree', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);
    expect(repo.get('s1')!.branch).toBeUndefined();
  });

  it('renames a session, updating both name and emoji', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    repo.setNameAndEmoji('s1', { name: 'Legolas', emoji: '🏹' });

    const session = repo.get('s1')!;
    expect(session.name).toBe('Legolas');
    expect(session.emoji).toBe('🏹');
  });

  it('renames only the field given, leaving the other untouched', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    repo.setNameAndEmoji('s1', { name: 'Legolas' });

    const session = repo.get('s1')!;
    expect(session.name).toBe('Legolas');
    expect(session.emoji).toBe('🤖');
  });

  it('sets the permission mode on an existing session', () => {
    const db = openDatabase(':memory:');
    const repo = new SessionRepository(db);
    repo.insert(baseRow);

    repo.setPermissionMode('s1', 'bypassPermissions');

    expect(repo.get('s1')!.permissionMode).toBe('bypassPermissions');
  });
});
