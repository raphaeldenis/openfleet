import type { DatabaseSync } from 'node:sqlite';
import type { HarnessId, Session, SessionState } from '@openfleet/shared';

interface Row {
  id: string; name: string; emoji: string; directory: string; worktree: string | null; model: string | null;
  parent_id: string | null; role: string | null; harness: HarnessId; state: SessionState; state_since: string;
  exit_code: number | null; hook_token: string; mcp_token: string; created_at: string; closed_at: string | null;
}

const toSession = (r: Row): Session => ({
  id: r.id, name: r.name, emoji: r.emoji, directory: r.directory, worktree: r.worktree ?? undefined,
  model: r.model ?? undefined, parentId: r.parent_id ?? undefined, role: r.role ?? undefined, harness: r.harness,
  state: r.state, stateSince: r.state_since, exitCode: r.exit_code ?? undefined, createdAt: r.created_at, closedAt: r.closed_at ?? undefined,
});

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: Omit<Row, 'exit_code' | 'closed_at'>): void {
    this.db.prepare(`INSERT INTO sessions (id, name, emoji, directory, worktree, model, parent_id, role, harness, state, state_since, hook_token, mcp_token, created_at)
      VALUES (@id, @name, @emoji, @directory, @worktree, @model, @parent_id, @role, @harness, @state, @state_since, @hook_token, @mcp_token, @created_at)`).run(row as never);
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
  setClosed(id: string, exitCode: number | undefined, at: string): void {
    this.db.prepare(`UPDATE sessions SET state = 'closed', state_since = ?, exit_code = ?, closed_at = ? WHERE id = ?`).run(at, exitCode ?? null, at, id);
  }
  byHookToken(token: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE hook_token = ?').get(token) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
  byMcpToken(token: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE mcp_token = ?').get(token) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
}
