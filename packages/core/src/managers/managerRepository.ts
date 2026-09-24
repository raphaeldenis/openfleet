import type { DatabaseSync } from 'node:sqlite';

export interface ManagerRecord {
  sessionId: string;
  pulseSeconds: number;
  childrenCap: number;
  missionText: string;
  lastPulseAt?: string;
  createdAt: string;
}

interface Row { session_id: string; pulse_seconds: number; children_cap: number; mission_text: string; last_pulse_at: string | null; created_at: string }

const toManager = (r: Row): ManagerRecord => ({
  sessionId: r.session_id, pulseSeconds: r.pulse_seconds, childrenCap: r.children_cap,
  missionText: r.mission_text, lastPulseAt: r.last_pulse_at ?? undefined, createdAt: r.created_at,
});

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
  list(): ManagerRecord[] {
    return (this.db.prepare('SELECT * FROM managers').all() as unknown as Row[]).map(toManager);
  }
  setLastPulseAt(sessionId: string, at: string): void {
    this.db.prepare('UPDATE managers SET last_pulse_at = ? WHERE session_id = ?').run(at, sessionId);
  }
}
