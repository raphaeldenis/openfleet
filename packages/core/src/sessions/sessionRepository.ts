import type { DatabaseSync } from 'node:sqlite';
import { PERMISSION_MODES, type HarnessId, type PermissionMode, type Session, type SessionState } from '@openfleet/shared';

interface Row {
  id: string; name: string; emoji: string; directory: string; worktree: string | null; model: string | null;
  parent_id: string | null; role: string | null; harness: HarnessId; state: SessionState; state_since: string;
  exit_code: number | null; hook_token: string; mcp_token: string; permission_mode: string | null; created_at: string; closed_at: string | null;
}

export interface NormalizedPermissionMode { mode: PermissionMode | undefined; wasRecognized: boolean }

// The DB column is an untrusted string, not a validated PermissionMode: a row written before Amendment A1,
// or by hand, can hold a value PERMISSION_MODES no longer (or never did) recognize. Both the repository
// mapper (every read) and the resume path (which additionally needs to know whether to warn) go through
// this single function so the two never drift.
export function normalizePermissionMode(stored: string | null | undefined): NormalizedPermissionMode {
  if (stored == null) return { mode: undefined, wasRecognized: true };
  // ponytail: 'default' was PERMISSION_MODES' entry before Amendment A1 renamed it to 'manual'; a dev
  // database can still hold rows written under the old name. The column is only ever set at INSERT,
  // so a legacy 'default' row stays 'default' forever; drop this guard only alongside a phase 3
  // migration that rewrites stored 'default' values to 'manual'.
  if (stored === 'default') return { mode: 'manual', wasRecognized: true };
  if ((PERMISSION_MODES as readonly string[]).includes(stored)) return { mode: stored as PermissionMode, wasRecognized: true };
  return { mode: undefined, wasRecognized: false };
}

const toSession = (r: Row): Session => ({
  id: r.id, name: r.name, emoji: r.emoji, directory: r.directory, worktree: r.worktree ?? undefined,
  model: r.model ?? undefined, parentId: r.parent_id ?? undefined, role: r.role ?? undefined, harness: r.harness,
  state: r.state, stateSince: r.state_since, exitCode: r.exit_code ?? undefined,
  permissionMode: normalizePermissionMode(r.permission_mode).mode,
  createdAt: r.created_at, closedAt: r.closed_at ?? undefined,
});

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: Omit<Row, 'exit_code' | 'closed_at'>): void {
    this.db.prepare(`INSERT INTO sessions (id, name, emoji, directory, worktree, model, parent_id, role, harness, state, state_since, hook_token, mcp_token, permission_mode, created_at)
      VALUES (@id, @name, @emoji, @directory, @worktree, @model, @parent_id, @role, @harness, @state, @state_since, @hook_token, @mcp_token, @permission_mode, @created_at)`).run(row as never);
  }
  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
  list(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as unknown as Row[]).map(toSession);
  }
  setState(id: string, state: SessionState, since: string): void {
    this.db.prepare('UPDATE sessions SET state = ?, state_since = ? WHERE id = ?').run(state, since, id);
  }
  setModel(id: string, model: string): void {
    this.db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(model, id);
  }
  setClosed(id: string, exitCode: number | undefined, at: string): void {
    this.db.prepare(`UPDATE sessions SET state = 'closed', state_since = ?, exit_code = ?, closed_at = ? WHERE id = ?`).run(at, exitCode ?? null, at, id);
  }
  closeAllOpen(at: string): void {
    this.db.prepare(`UPDATE sessions SET state = 'closed', state_since = ?, closed_at = ? WHERE state <> 'closed'`).run(at, at);
  }
  byHookToken(token: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE hook_token = ?').get(token) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
  byMcpToken(token: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE mcp_token = ?').get(token) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
  setTokens(id: string, hookToken: string, mcpToken: string): void {
    this.db.prepare('UPDATE sessions SET hook_token = ?, mcp_token = ? WHERE id = ?').run(hookToken, mcpToken, id);
  }
  tokens(id: string): { hookToken: string; mcpToken: string } | undefined {
    const row = this.db.prepare('SELECT hook_token, mcp_token FROM sessions WHERE id = ?').get(id) as { hook_token: string; mcp_token: string } | undefined;
    return row ? { hookToken: row.hook_token, mcpToken: row.mcp_token } : undefined;
  }
  // The raw, unnormalized column — for resolveResumePermissionMode, which needs to know whether the
  // stored value was recognized, not just its normalized Session.permissionMode.
  rawPermissionMode(id: string): string | null | undefined {
    const row = this.db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get(id) as { permission_mode: string | null } | undefined;
    return row?.permission_mode;
  }
}
