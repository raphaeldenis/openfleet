import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';
import { PERMISSION_MODES, parseSessionCloseReason, type HarnessId, type PermissionMode, type Session, type SessionCloseReason, type SessionState } from '@openfleet/shared';

interface Row {
  id: string; name: string; emoji: string; directory: string; worktree: string | null; model: string | null;
  parent_id: string | null; role: string | null; harness: HarnessId; state: SessionState; state_since: string;
  exit_code: number | null; close_reason: string | null; hook_token: string; mcp_token: string; permission_mode: string | null; branch: string | null;
  created_at: string; closed_at: string | null; project_id: string | null;
  resolved_model: string | null; cli_version: string | null; model_drifted_from: string | null; resolved_for_model: string | null;
  context_notice_tokens: number | null;
}

type NewSessionRow = Omit<Row, 'exit_code' | 'close_reason' | 'closed_at' | 'project_id' | 'resolved_model' | 'cli_version' | 'model_drifted_from' | 'resolved_for_model' | 'context_notice_tokens'> & { project_id?: string | null };

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
  branch: r.branch ?? undefined,
  model: r.model ?? undefined,
  resolvedModel: r.resolved_model ?? undefined, cliVersion: r.cli_version ?? undefined, modelDriftedFrom: r.model_drifted_from ?? undefined,
  contextNoticeTokens: r.context_notice_tokens ?? undefined,
  parentId: r.parent_id ?? undefined, projectId: r.project_id ?? undefined, role: r.role ?? undefined, harness: r.harness,
  state: r.state, stateSince: r.state_since, exitCode: r.exit_code ?? undefined,
  closeReason: parseSessionCloseReason(r.close_reason),
  permissionMode: normalizePermissionMode(r.permission_mode).mode,
  createdAt: r.created_at, closedAt: r.closed_at ?? undefined,
});

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: NewSessionRow): void {
    const rowWithProject = { ...row, project_id: row.project_id ?? null };
    this.db.prepare(`INSERT INTO sessions (id, name, emoji, directory, worktree, model, parent_id, role, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, project_id, created_at)
      VALUES (@id, @name, @emoji, @directory, @worktree, @model, @parent_id, @role, @harness, @state, @state_since, @hook_token, @mcp_token, @permission_mode, @branch, @project_id, @created_at)`).run(rowWithProject as never);
  }
  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
  list(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as unknown as Row[]).map(toSession);
  }
  // exit_code and close_reason describe a close, so they go as soon as the session leaves 'closed'. closed_at also marks a
  // reopened session as "closed, coming back" for the whole 'starting' window, so it only goes once the
  // session is live (any state past 'starting').
  setState(id: string, state: SessionState, since: string): void {
    const isClosed = state === 'closed';
    const isComingBack = state === 'starting';
    const keepsCloseDescription = isClosed;
    const keepsClosedAt = isClosed || isComingBack;
    this.db.prepare(`UPDATE sessions SET state = ?, state_since = ?,
      exit_code = CASE WHEN ? THEN exit_code END, close_reason = CASE WHEN ? THEN close_reason END, closed_at = CASE WHEN ? THEN closed_at END WHERE id = ?`)
      .run(state, since, Number(keepsCloseDescription), Number(keepsCloseDescription), Number(keepsClosedAt), id);
  }
  /** Records a reopen and returns the id of the row it inserted. */
  recordReopen(id: string, at: string): number {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES (?, 'reopened', ?)").run(id, at);
    return Number(lastInsertRowid);
  }
  removeReopen(reopenEventId: number): void {
    this.db.prepare('DELETE FROM session_events WHERE id = ?').run(reopenEventId);
  }
  setModel(id: string, model: string): void {
    this.db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(model, id);
  }
  setContextNoticeTokens(id: string, tokens: number | null): void {
    const storableTokens = Number.isSafeInteger(tokens) ? tokens : null;
    this.db.prepare('UPDATE sessions SET context_notice_tokens = ? WHERE id = ?').run(storableTokens, id);
  }
  clearResolvedModel(id: string): void {
    this.db.prepare('UPDATE sessions SET resolved_model = NULL, resolved_for_model = NULL, model_drifted_from = NULL WHERE id = ?').run(id);
  }
  // requestedModel is the alias the recorded launch was started with: sessions.model may already name the next one.
  // driftedFrom: a string sets the flag, null clears it (a computed "no drift"), absent leaves it as is.
  recordResolvedModel(input: { id: string; resolvedModel: string; cliVersion: string; requestedModel: string | null; driftedFrom?: string | null }): void {
    const isComputed = input.driftedFrom !== undefined;
    this.db.prepare('UPDATE sessions SET resolved_model = ?, cli_version = ?, resolved_for_model = ?, model_drifted_from = CASE WHEN ? THEN ? ELSE model_drifted_from END WHERE id = ?')
      .run(input.resolvedModel, input.cliVersion, input.requestedModel, Number(isComputed), input.driftedFrom ?? null, input.id);
  }
  // `IS ?` matches a NULL requested model too.
  resolvedModelUnderAlias(input: { id: string; requestedModel: string | null }): string | undefined {
    const row = this.db.prepare('SELECT resolved_model FROM sessions WHERE id = ? AND resolved_for_model IS ?')
      .get(input.id, input.requestedModel) as { resolved_model: string | null } | undefined;
    return row?.resolved_model ?? undefined;
  }
  // ponytail: the id comes from a transcript the session's own agent can write, so one session can plant any valid model id here
  // and make a later session of the same alias show modelDriftedFrom = that id. Display-only, never fed back to --model (spec 4.4).
  // Upgrade path: compare only against ids seen in more than one session, or record them from a source the agent cannot write.
  // The latest other session with a recorded id under the alias, ordered by (created_at, rowid): creation time is a proxy for
  // "resolved last", and rowid breaks a same-millisecond tie. No column stamps the recording time, so two ceilings remain:
  // a "reversed drift" (an old session that records after a newer one is compared with that newer one) and a session
  // resumed long after its creation, whose resolution is ranked by when it was created. Upgrade path: order by a resolved_at column.
  previousResolvedModel(input: { requestedModel: string | null; excludedSessionId: string }): { sessionId: string; resolvedModel: string } | undefined {
    const row = this.db.prepare(`SELECT id, resolved_model FROM sessions
      WHERE resolved_for_model IS ? AND resolved_model IS NOT NULL AND id <> ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(input.requestedModel, input.excludedSessionId) as { id: string; resolved_model: string } | undefined;
    return row ? { sessionId: row.id, resolvedModel: row.resolved_model } : undefined;
  }
  setPermissionMode(id: string, mode: PermissionMode): void {
    this.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id);
  }
  setNameAndEmoji(id: string, patch: { name?: string; emoji?: string }): void {
    this.db.prepare('UPDATE sessions SET name = COALESCE(?, name), emoji = COALESCE(?, emoji) WHERE id = ?').run(patch.name ?? null, patch.emoji ?? null, id);
  }
  // Closes and rotates tokens in one statement: a row can never sit closed with its pre-close tokens
  // still live, even for the instant between two separate writes (or if the second one never ran).
  // A daemon-shutdown close also records the session's single 'daemon_shutdown' event stamped with the same instant as closed_at:
  // that event is what tells the next boot this close was the daemon's, not the user's. Every close replaces the session's
  // previous event, so a later close never matches an earlier shutdown's event.
  setClosed(id: string, exitCode: number | undefined, at: string, hookToken: string, mcpToken: string, options: { closedByDaemonShutdown?: boolean; closeReason?: SessionCloseReason } = {}): void {
    inTransaction(this.db, 'set_session_closed', () => {
      this.db.prepare(`UPDATE sessions SET state = 'closed', state_since = ?, exit_code = ?, close_reason = ?, closed_at = ?, hook_token = ?, mcp_token = ? WHERE id = ?`)
        .run(at, exitCode ?? null, options.closeReason ?? null, at, hookToken, mcpToken, id);
      this.clearShutdownClose(id);
      if (options.closedByDaemonShutdown) this.db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES (?, 'daemon_shutdown', ?)").run(id, at);
    });
  }
  /** Forgets that a daemon shutdown closed the session: it stays closed (a user close) or is being resumed. */
  clearShutdownClose(id: string): void {
    this.db.prepare("DELETE FROM session_events WHERE session_id = ? AND kind = 'daemon_shutdown'").run(id);
  }
  /** Consumes the shutdown close and sets the session back to 'starting' in one transaction. */
  resumeFromShutdownClose(id: string, since: string): void {
    inTransaction(this.db, 'resume_from_shutdown_close', () => {
      this.clearShutdownClose(id);
      this.setState(id, 'starting', since);
    });
  }
  /** Consumes the shutdown close, sets the session back to 'starting' and records the reopen in one transaction; returns the reopen event id. */
  reopenFromShutdownClose(id: string, at: string): number {
    return inTransaction(this.db, 'reopen_from_shutdown_close', () => {
      this.resumeFromShutdownClose(id, at);
      return this.recordReopen(id, at);
    });
  }
  /** Rewrites a closed row as a failed close in one transaction: the given exit code and reason, a fresh closed_at, no shutdown marker. */
  failClosedRow(id: string, exitCode: number, at: string, options: { closeReason?: SessionCloseReason } = {}): void {
    inTransaction(this.db, 'fail_shutdown_close', () => {
      this.clearShutdownClose(id);
      this.db.prepare('UPDATE sessions SET state_since = ?, exit_code = ?, close_reason = ?, closed_at = ? WHERE id = ?').run(at, exitCode, options.closeReason ?? null, at, id);
    });
  }
  /** True when the session's current close is the one a daemon shutdown made and no resume or later close has consumed it. */
  wasClosedByDaemonShutdown(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS found FROM session_events JOIN sessions ON sessions.id = session_events.session_id
      WHERE session_events.session_id = ? AND session_events.kind = 'daemon_shutdown' AND session_events.ts = sessions.closed_at`).get(id);
    return row !== undefined;
  }
  closeAllOpen(at: string): void {
    this.db.prepare(`UPDATE sessions SET state = 'closed', state_since = ?, closed_at = ? WHERE state <> 'closed'`).run(at, at);
  }
  // The state filter, not just token rotation on close, is what makes a closed row's token refuse to
  // authenticate: a row a pre-patch build left closed (never rotated by this build's markClosed) must
  // still be rejected, and this lookup is the one place every such row passes through regardless of history.
  byHookToken(token: string): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE hook_token = ? AND state <> 'closed'`).get(token) as Row | undefined;
    return row ? toSession(row) : undefined;
  }
  byMcpToken(token: string): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE mcp_token = ? AND state <> 'closed'`).get(token) as Row | undefined;
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
  // Not part of Session: only reopen's directory-swap guard reads it, so it lives outside the mapped
  // columns like rawPermissionMode does.
  setDirectoryRealpath(id: string, realpath: string | null): void {
    this.db.prepare('UPDATE sessions SET directory_realpath = ? WHERE id = ?').run(realpath, id);
  }
  directoryRealpath(id: string): string | null | undefined {
    const row = this.db.prepare('SELECT directory_realpath FROM sessions WHERE id = ?').get(id) as { directory_realpath: string | null } | undefined;
    return row?.directory_realpath;
  }
  // The CLI's current conversation id, outside Session like directoryRealpath: NULL means the session
  // never left its launch conversation, which is the OpenFleet session id.
  cliSessionId(id: string): string | null | undefined {
    const row = this.db.prepare('SELECT cli_session_id FROM sessions WHERE id = ?').get(id) as { cli_session_id: string | null } | undefined;
    return row?.cli_session_id;
  }
  // Every id a session ever adopted stays reserved to it in session_cli_ids, also once it moved on.
  setCliSessionId(id: string, cliSessionId: string): void {
    inTransaction(this.db, 'set_cli_session_id', () => {
      this.db.prepare('UPDATE sessions SET cli_session_id = ? WHERE id = ?').run(cliSessionId, id);
      this.db.prepare('INSERT OR IGNORE INTO session_cli_ids (cli_session_id, session_id) VALUES (?, ?)').run(cliSessionId, id);
    });
  }
  // Whether a user prompt reached the CLI's current conversation, outside Session like cliSessionId: only such a
  // conversation has a transcript worth resuming, and only its loss is worth announcing.
  isCurrentConversationPrompted(id: string): boolean {
    const row = this.db.prepare('SELECT prompted FROM sessions WHERE id = ?').get(id) as { prompted: number } | undefined;
    return row?.prompted === 1;
  }
  setCurrentConversationPrompted(id: string, isPrompted: boolean): void {
    this.db.prepare('UPDATE sessions SET prompted = ? WHERE id = ?').run(isPrompted ? 1 : 0, id);
  }
  isCliSessionIdOfAnotherSession(id: string, cliSessionId: string): boolean {
    const isLaunchOrCurrentIdOfAnother = this.db.prepare('SELECT 1 AS found FROM sessions WHERE id <> ? AND (id = ? OR cli_session_id = ?)').get(id, cliSessionId, cliSessionId) !== undefined;
    const isLeftBehindByAnother = this.db.prepare('SELECT 1 AS found FROM session_cli_ids WHERE session_id <> ? AND cli_session_id = ?').get(id, cliSessionId) !== undefined;
    return isLaunchOrCurrentIdOfAnother || isLeftBehindByAnother;
  }
}
