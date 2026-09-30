import { WorkingStateSectionsSchema, type WorkingState, type WorkingStateSections } from '@openfleet/shared';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { renderWorkingState } from './renderWorkingState.js';

export class WorkingStateTooLargeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`working state is ${bytes} bytes, the cap is ${maxBytes}: keep the current state only, move history to the log`);
  }
}

const MIRROR_WARNING = 'the state is saved but its mirror file could not be written';
const SESSION_ID_SHAPE = /^[0-9a-f-]{36}$/;
const isSafeMirrorFileStem = (sessionId: string) => SESSION_ID_SHAPE.test(sessionId) && basename(sessionId) === sessionId;

export interface WorkingStateServiceDeps { db: DatabaseSync; clock: () => string; stateRoot: string; maxBytes: number }

export interface WorkingStateUpdate { updatedAt: string; mirrorWarning?: string }

type UpdateListener = (state: WorkingState) => void;

export interface FleetChange { name: string; kind: 'spawned' | 'closed' | 'reopened'; changedAt: string }

interface StateRow { sections_json: string; updated_at: string }

export class WorkingStateService {
  private readonly listeners = new Set<UpdateListener>();

  constructor(private readonly deps: WorkingStateServiceDeps) {}

  get maxBytes(): number {
    return this.deps.maxBytes;
  }

  /** Replaces the whole state of a session, stamped with the daemon clock; the mirror file follows and never fails the update. */
  update(sessionId: string, candidateSections: WorkingStateSections): WorkingStateUpdate {
    const sections = WorkingStateSectionsSchema.parse(candidateSections);
    const bytes = Buffer.byteLength(renderWorkingState(sections), 'utf8');
    if (bytes > this.deps.maxBytes) throw new WorkingStateTooLargeError(bytes, this.deps.maxBytes);

    const updatedAt = this.deps.clock();
    this.deps.db.prepare(`INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET sections_json = excluded.sections_json, updated_at = excluded.updated_at`)
      .run(sessionId, JSON.stringify(sections), updatedAt);

    const mirrorWarning = this.writeMirror(sessionId, sections);
    const state = this.get(sessionId)!;
    this.notifyListeners(state);
    return mirrorWarning ? { updatedAt, mirrorWarning } : { updatedAt };
  }

  get(sessionId: string): WorkingState | undefined {
    const row = this.deps.db.prepare('SELECT sections_json, updated_at FROM session_working_states WHERE session_id = ?').get(sessionId) as StateRow | undefined;
    if (!row) return undefined;
    const sections = JSON.parse(row.sections_json) as WorkingStateSections;
    const fleetChangedAt = this.fleetChangedAt(sessionId);
    return { ...sections, sessionId, updatedAt: row.updated_at, ...(fleetChangedAt ? { fleetChangedAt } : {}) };
  }

  /** The latest spawn, close or reopen time among the direct children of a session; none for a session with no child. */
  fleetChangedAt(sessionId: string): string | undefined {
    const latest = this.deps.db.prepare(`SELECT MAX(changedAt) AS latest FROM (
      SELECT created_at AS changedAt FROM sessions WHERE parent_id = ?
      UNION ALL
      SELECT closed_at AS changedAt FROM sessions WHERE parent_id = ? AND closed_at IS NOT NULL
      UNION ALL
      SELECT session_events.ts AS changedAt FROM session_events
        JOIN sessions ON sessions.id = session_events.session_id
        WHERE sessions.parent_id = ? AND session_events.kind = 'reopened')`).get(sessionId, sessionId, sessionId) as { latest: string | null };
    return latest.latest ?? undefined;
  }

  /** Every spawn, close and reopen of a direct child, oldest first. No row is ever deleted: a deleted child would have to count too, or the value goes backwards. */
  fleetChanges(sessionId: string): FleetChange[] {
    return this.deps.db.prepare(`SELECT name, 'spawned' AS kind, created_at AS changedAt FROM sessions WHERE parent_id = ?
      UNION ALL
      SELECT name, 'closed' AS kind, closed_at AS changedAt FROM sessions WHERE parent_id = ? AND closed_at IS NOT NULL
      UNION ALL
      SELECT sessions.name, 'reopened' AS kind, session_events.ts AS changedAt FROM session_events
        JOIN sessions ON sessions.id = session_events.session_id
        WHERE sessions.parent_id = ? AND session_events.kind = 'reopened'
      ORDER BY changedAt, name`).all(sessionId, sessionId, sessionId) as unknown as FleetChange[];
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(state: WorkingState): void {
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        log('warn', `working state update listener failed for session ${state.sessionId}`, error);
      }
    }
  }

  private writeMirror(sessionId: string, sections: WorkingStateSections): string | undefined {
    if (!isSafeMirrorFileStem(sessionId)) {
      log('warn', `working state mirror refused for session id ${JSON.stringify(sessionId)}: not a plain session id`);
      return MIRROR_WARNING;
    }
    const mirrorPath = join(this.deps.stateRoot, `${sessionId}.md`);
    const temporaryPath = `${mirrorPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.deps.stateRoot, { recursive: true, mode: 0o700 });
      // mkdirSync's mode is ignored on a directory that already exists: tightened on every write.
      chmodSync(this.deps.stateRoot, 0o700);
      writeFileSync(temporaryPath, renderWorkingState(sections), { flag: 'wx', mode: 0o600 });
      // The atomic replace is not observable from a test: a reader seeing a half-written mirror is an accepted, untested risk.
      renameSync(temporaryPath, mirrorPath);
      return undefined;
    } catch (error) {
      this.removeTemporaryFile(temporaryPath);
      log('warn', `working state mirror not written for session ${sessionId}`, error);
      return MIRROR_WARNING;
    }
  }

  private removeTemporaryFile(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      log('warn', 'working state temporary file not removed', error);
    }
  }
}
