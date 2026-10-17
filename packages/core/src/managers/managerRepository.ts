import type { DatabaseSync } from 'node:sqlite';
import { ManagerRecordBoundsSchema, type ManagerBaseRead } from '@openfleet/shared';
import { log } from '../logger.js';

export interface ManagerRecord {
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
  /** The whole manager base the manager last read; absent while it never read it. */
  baseRead?: ManagerBaseRead;
}

interface Row {
  session_id: string; pulse_seconds: number; children_cap: number; mission_text: string; last_pulse_at: string | null; created_at: string;
  mission_note_id: string | null; pin_mission_note: number; log_store_id: string | null; pulse_enabled: number;
  base_version_read: number | null; base_sha_read: string | null; base_read_at: string | null;
}

const baseReadOf = (r: Row): ManagerBaseRead | undefined => {
  const hasRead = r.base_version_read !== null && r.base_sha_read !== null && r.base_read_at !== null;
  return hasRead ? { version: r.base_version_read!, sha: r.base_sha_read!, readAt: r.base_read_at! } : undefined;
};

const toManager = (r: Row): ManagerRecord => ({
  sessionId: r.session_id, pulseSeconds: r.pulse_seconds, childrenCap: r.children_cap,
  missionText: r.mission_text, lastPulseAt: r.last_pulse_at ?? undefined, createdAt: r.created_at,
  missionNoteId: r.mission_note_id ?? undefined, pinMissionNote: r.pin_mission_note === 1, logStoreId: r.log_store_id ?? undefined,
  pulseEnabled: r.pulse_enabled === 1,
  baseRead: baseReadOf(r),
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
  update(sessionId: string, fields: Partial<Pick<ManagerRecord, 'pulseSeconds' | 'childrenCap' | 'missionText'>>): void {
    const current = this.get(sessionId);
    if (!current) return;
    const next = { ...current, ...definedFieldsOf(fields) };
    this.db.prepare('UPDATE managers SET pulse_seconds = ?, children_cap = ?, mission_text = ? WHERE session_id = ?')
      .run(next.pulseSeconds, next.childrenCap, next.missionText, sessionId);
  }
  setLastPulseAt(sessionId: string, at: string): void {
    this.db.prepare('UPDATE managers SET last_pulse_at = ? WHERE session_id = ?').run(at, sessionId);
  }
  /** Links the note holding the mission; null unlinks it. */
  setMissionNote(sessionId: string, noteId: string | null): void {
    this.db.prepare('UPDATE managers SET mission_note_id = ? WHERE session_id = ?').run(noteId, sessionId);
  }
  setMissionNotePinned(sessionId: string, isPinned: boolean): void {
    this.db.prepare('UPDATE managers SET pin_mission_note = ? WHERE session_id = ?').run(Number(isPinned), sessionId);
  }
  setPulseEnabled(sessionId: string, isEnabled: boolean): void {
    this.db.prepare('UPDATE managers SET pulse_enabled = ? WHERE session_id = ?').run(Number(isEnabled), sessionId);
  }
  /** Remembers the manager base the manager just read whole. */
  recordBaseRead(sessionId: string, { version, sha, readAt }: ManagerBaseRead): void {
    this.db.prepare('UPDATE managers SET base_version_read = ?, base_sha_read = ?, base_read_at = ? WHERE session_id = ?').run(version, sha, readAt, sessionId);
  }
  /** Forgets the manager base the manager read: it has not read any since. */
  clearBaseRead(sessionId: string): void {
    this.db.prepare('UPDATE managers SET base_version_read = NULL, base_sha_read = NULL, base_read_at = NULL WHERE session_id = ?').run(sessionId);
  }
  /** Binds the table the manager logs its actions in; null unbinds it. */
  setLogStore(sessionId: string, storeId: string | null): void {
    this.db.prepare('UPDATE managers SET log_store_id = ? WHERE session_id = ?').run(storeId, sessionId);
  }
}
