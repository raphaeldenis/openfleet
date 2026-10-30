import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactJournal, ArtifactJournalEntry } from './artifactDirectory.js';

export const ARTIFACT_WRITE_EVENT_KIND = 'artifact_write';
export const ARTIFACT_WRITE_REFUSED_EVENT_KIND = 'artifact_write_refused';

/** Appends one `session_events` row per judged write; the actor and the path go in the row's payload. */
export class SqliteArtifactJournal implements ArtifactJournal {
  constructor(private readonly deps: { db: DatabaseSync; clock: () => string }) {}

  record(entry: ArtifactJournalEntry): void {
    const { sessionId, outcome, ...payload } = entry;
    const kind = outcome === 'granted' ? ARTIFACT_WRITE_EVENT_KIND : ARTIFACT_WRITE_REFUSED_EVENT_KIND;
    this.deps.db.prepare('INSERT INTO session_events (session_id, kind, payload_json, ts) VALUES (?, ?, ?, ?)')
      .run(sessionId, kind, JSON.stringify({ sessionId, ...payload }), this.deps.clock());
  }
}
