import type { WorkingState, WorkingStateSections } from '@openfleet/shared';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { renderWorkingState } from './renderWorkingState.js';

export class WorkingStateTooLargeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`working state is ${bytes} bytes, the cap is ${maxBytes}: keep the current state only, move history to the log`);
  }
}

export interface WorkingStateServiceDeps { db: DatabaseSync; clock: () => string; stateRoot: string; maxBytes: number }

export interface WorkingStateUpdate { updatedAt: string; mirrorWarning?: string }

type UpdateListener = (state: WorkingState) => void;

interface StateRow { sections_json: string; updated_at: string }

export class WorkingStateService {
  private readonly listeners = new Set<UpdateListener>();

  constructor(private readonly deps: WorkingStateServiceDeps) {}

  get maxBytes(): number {
    return this.deps.maxBytes;
  }

  /** Replaces the whole state of a session, stamped with the daemon clock; the mirror file follows and never fails the update. */
  update(sessionId: string, sections: WorkingStateSections): WorkingStateUpdate {
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

  /** The latest creation or close time among the direct children of a session; none for a session with no child. */
  fleetChangedAt(sessionId: string): string | undefined {
    const row = this.deps.db.prepare(`SELECT MAX(changed_at) AS latest FROM (
      SELECT created_at AS changed_at FROM sessions WHERE parent_id = ?
      UNION ALL
      SELECT closed_at AS changed_at FROM sessions WHERE parent_id = ? AND closed_at IS NOT NULL)`).get(sessionId, sessionId) as { latest: string | null };
    return row.latest ?? undefined;
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
    const mirrorPath = join(this.deps.stateRoot, `${sessionId}.md`);
    const temporaryPath = `${mirrorPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.deps.stateRoot, { recursive: true, mode: 0o700 });
      // mkdirSync's mode is ignored on a directory that already exists: tightened on every write.
      chmodSync(this.deps.stateRoot, 0o700);
      writeFileSync(temporaryPath, renderWorkingState(sections), { flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, mirrorPath);
      return undefined;
    } catch (error) {
      this.removeTemporaryFile(temporaryPath);
      log('warn', `working state mirror not written for session ${sessionId}`, error);
      return 'the state is saved but its mirror file could not be written';
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
