import type { DatabaseSync } from 'node:sqlite';
import { ManagerExpertiseSchema, ManagerPulseActionsSchema, ManagerRecordBoundsSchema, OpenFleetError, type ManagerBaseRead } from '@openfleet/shared';
import { afterCommit, inTransaction } from '../db/transaction.js';
import { log } from '../logger.js';
import type { NoteReadProgress } from './noteReadGuard.js';

export interface ManagerRecord {
  expertise?: string;
  pulseActions?: string[];
  profileRev?: number;
  sessionId: string;
  pulseSeconds: number;
  childrenCap: number;
  missionText: string;
  lastPulseAt?: string;
  createdAt: string;
  missionNoteId?: string;
  pinMissionNote?: boolean;
  logStoreId?: string;
  /** Absent on a new record: the manager starts enabled. False while paused. */
  pulseEnabled?: boolean;
  /** Absent on a new record: the manager's children are not restarted when they crash. */
  childAutoRestart?: boolean;
  /** The whole manager base the manager last read; absent while it never read it. */
  baseRead?: ManagerBaseRead;
  /** What the manager has read of its mission note since its context was last reset; absent while it read nothing. */
  noteRead?: NoteReadProgress;
  /** When the manager's context was last reset while it had a mission note to read; absent once it read the note in full again. */
  noteReadResetAt?: string;
}

interface Row {
  expertise: string | null; pulse_actions: string | null; profile_rev: number;
  session_id: string; pulse_seconds: number; children_cap: number; mission_text: string; last_pulse_at: string | null; created_at: string;
  mission_note_id: string | null; pin_mission_note: number; log_store_id: string | null; pulse_enabled: number; child_auto_restart: number;
  base_version_read: number | null; base_sha_read: string | null; base_read_at: string | null;
  note_read: string | null; note_read_reset_at: string | null;
}

const pulseActionsOf = (row: Row): string[] => {
  if (row.pulse_actions === null) return [];
  try {
    const validation = ManagerPulseActionsSchema.safeParse(JSON.parse(row.pulse_actions));
    if (validation.success) return validation.data;
  } catch { /* Invalid JSON follows the same empty-profile fallback as invalid actions. */ }
  log('warn', `ManagerRepository: invalid pulse actions for session ${row.session_id}`);
  return [];
};

const expertiseOf = (row: Row): string => {
  if (row.expertise === null) return '';
  const validation = ManagerExpertiseSchema.safeParse(row.expertise);
  if (validation.success) return validation.data;
  log('warn', `ManagerRepository: invalid expertise for session ${row.session_id}`);
  return '';
};

const baseReadOf = (r: Row): ManagerBaseRead | undefined => {
  const hasRead = r.base_version_read !== null && r.base_sha_read !== null && r.base_read_at !== null;
  return hasRead ? { version: r.base_version_read!, sha: r.base_sha_read!, readAt: r.base_read_at! } : undefined;
};

const noteReadOf = (r: Row): NoteReadProgress | undefined => {
  if (r.note_read === null) return undefined;
  try {
    return JSON.parse(r.note_read) as NoteReadProgress;
  } catch {
    log('warn', `ManagerRepository: invalid note read for session ${r.session_id}`);
    return undefined;
  }
};

const toManager = (r: Row): ManagerRecord => ({
  expertise: expertiseOf(r), pulseActions: pulseActionsOf(r), profileRev: r.profile_rev,
  sessionId: r.session_id, pulseSeconds: r.pulse_seconds, childrenCap: r.children_cap,
  missionText: r.mission_text, lastPulseAt: r.last_pulse_at ?? undefined, createdAt: r.created_at,
  missionNoteId: r.mission_note_id ?? undefined, pinMissionNote: r.pin_mission_note === 1, logStoreId: r.log_store_id ?? undefined,
  pulseEnabled: r.pulse_enabled === 1,
  childAutoRestart: r.child_auto_restart === 1,
  baseRead: baseReadOf(r),
  noteRead: noteReadOf(r), noteReadResetAt: r.note_read_reset_at ?? undefined,
});

/** Whether the manager receives pulses: only an explicit false pauses it. */
export const isPulseEnabled = (record: Pick<ManagerRecord, 'pulseEnabled'>): boolean => record.pulseEnabled !== false;

const definedFieldsOf = <T extends object>(fields: T): Partial<T> => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

export class ManagerRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(record: ManagerRecord): void {
    this.db.prepare('INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, last_pulse_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.sessionId, record.pulseSeconds, record.childrenCap, record.missionText, record.lastPulseAt ?? null, record.createdAt);
  }
  get(sessionId: string): ManagerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM managers WHERE session_id = ?').get(sessionId) as Row | undefined;
    return row ? toManager(row) : undefined;
  }
  getWithinBounds(sessionId: string): ManagerRecord | undefined {
    const record = this.get(sessionId);
    return record && this.isWithinBounds(record) ? record : undefined;
  }
  list(): ManagerRecord[] {
    return (this.db.prepare('SELECT * FROM managers').all() as unknown as Row[]).map(toManager).filter((record) => this.isWithinBounds(record));
  }

  private isWithinBounds(record: ManagerRecord): boolean {
    const validation = ManagerRecordBoundsSchema.safeParse({ pulseSeconds: record.pulseSeconds, childrenCap: record.childrenCap, mission: record.missionText });
    if (validation.success) return true;
    log('warn', `ManagerRepository: skipping manager row for session ${record.sessionId} — out of bounds`);
    return false;
  }
  /** Changes the given fields of an existing manager row; the others stay as they are. */
  update(sessionId: string, fields: Partial<Pick<ManagerRecord, 'pulseSeconds' | 'childrenCap' | 'missionText' | 'expertise' | 'pulseActions'>>): void {
    const current = this.get(sessionId);
    if (!current) return;
    const next = { ...current, ...definedFieldsOf(fields) };
    this.db.prepare('UPDATE managers SET pulse_seconds = ?, children_cap = ?, mission_text = ?, expertise = ?, pulse_actions = ? WHERE session_id = ?')
      .run(next.pulseSeconds, next.childrenCap, next.missionText, next.expertise ?? null, JSON.stringify(next.pulseActions ?? []), sessionId);
  }

  changeProfile(input: {
    sessionId: string;
    expectedProfileRev?: number;
    apply: (stored: ManagerRecord) => boolean;
    committed: (updated: ManagerRecord) => void;
  }): ManagerRecord | undefined {
    return inTransaction(this.db, 'changeManagerProfile', () => {
      const stored = this.get(input.sessionId);
      if (!stored) return undefined;
      const isStale = input.expectedProfileRev !== undefined && input.expectedProfileRev !== stored.profileRev;
      if (isStale) throw new OpenFleetError('stale_revision', 'the manager profile has changed since the revision you read.', {
        hint: 'reload the manager profile, then write again.',
        detail: { resource: 'manager_profile', currentRev: stored.profileRev },
      });
      const hasChanges = input.apply(stored);
      if (!hasChanges) return stored;
      this.db.prepare('UPDATE managers SET profile_rev = profile_rev + 1 WHERE session_id = ?').run(input.sessionId);
      const updated = this.get(input.sessionId)!;
      afterCommit(this.db, () => input.committed(updated));
      return updated;
    });
  }
  setLastPulseAt(sessionId: string, at: string): void {
    this.db.prepare('UPDATE managers SET last_pulse_at = ? WHERE session_id = ?').run(at, sessionId);
  }
  /** Links the note holding the mission; null unlinks it. */
  setMissionNote(sessionId: string, noteId: string | null): void {
    this.db.prepare('UPDATE managers SET mission_note_id = ? WHERE session_id = ?').run(noteId, sessionId);
  }
  /** Whether any manager, in bounds or not, links the note as its mission. */
  isMissionNote(noteId: string): boolean {
    return this.db.prepare('SELECT 1 FROM managers WHERE mission_note_id = ? LIMIT 1').get(noteId) !== undefined;
  }
  setMissionNotePinned(sessionId: string, isPinned: boolean): void {
    this.db.prepare('UPDATE managers SET pin_mission_note = ? WHERE session_id = ?').run(Number(isPinned), sessionId);
  }
  setPulseEnabled(sessionId: string, isEnabled: boolean): void {
    this.db.prepare('UPDATE managers SET pulse_enabled = ? WHERE session_id = ?').run(Number(isEnabled), sessionId);
  }
  setChildAutoRestart(sessionId: string, isEnabled: boolean): void {
    this.db.prepare('UPDATE managers SET child_auto_restart = ? WHERE session_id = ?').run(Number(isEnabled), sessionId);
  }
  /** Remembers the manager base the manager just read whole. */
  recordBaseRead(sessionId: string, { version, sha, readAt }: ManagerBaseRead): void {
    this.db.prepare('UPDATE managers SET base_version_read = ?, base_sha_read = ?, base_read_at = ? WHERE session_id = ?').run(version, sha, readAt, sessionId);
  }
  /** Forgets the manager base the manager read: it has not read any since. */
  clearBaseRead(sessionId: string): void {
    this.db.prepare('UPDATE managers SET base_version_read = NULL, base_sha_read = NULL, base_read_at = NULL WHERE session_id = ?').run(sessionId);
  }
  /** Remembers what the manager has read of its mission note. */
  setNoteRead(sessionId: string, progress: NoteReadProgress): void {
    this.db.prepare('UPDATE managers SET note_read = ? WHERE session_id = ?').run(JSON.stringify(progress), sessionId);
  }
  /** Forgets what the manager read of its mission note, and dates the reset. */
  resetNoteRead(sessionId: string, resetAt: string): void {
    this.db.prepare('UPDATE managers SET note_read = NULL, note_read_reset_at = ? WHERE session_id = ?').run(resetAt, sessionId);
  }
  /** Stops reminding the manager that its context was reset: it read the mission note in full again. */
  clearNoteReadReset(sessionId: string): void {
    this.db.prepare('UPDATE managers SET note_read_reset_at = NULL WHERE session_id = ?').run(sessionId);
  }
  /** Binds the table the manager logs its actions in; null unbinds it. */
  setLogStore(sessionId: string, storeId: string | null): void {
    this.db.prepare('UPDATE managers SET log_store_id = ? WHERE session_id = ?').run(storeId, sessionId);
  }
}
