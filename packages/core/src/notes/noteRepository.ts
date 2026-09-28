import type { DatabaseSync } from 'node:sqlite';
import type { Note, NoteFolder } from '@openfleet/shared';

export type NoteUpdateResult =
  | { outcome: 'updated'; note: Note }
  | { outcome: 'stale_revision'; currentRev: number }
  | { outcome: 'not_found' };

export interface NoteBodyUpdate {
  bodyMd: string;
  expectedRev: number;
  updatedAt: string;
}

interface Row {
  id: string; project_id: string; title: string; body_md: string; folder: NoteFolder | null;
  file_path: string | null; rev: number; shared: number; created_at: string; updated_at: string;
}

const toNote = (r: Row): Note => ({
  id: r.id, projectId: r.project_id, title: r.title, bodyMd: r.body_md, folder: r.folder,
  filePath: r.file_path, rev: r.rev, shared: r.shared === 1, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class NoteRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(note: Note): void {
    this.db.prepare(`INSERT INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(note.id, note.projectId, note.title, note.bodyMd, note.folder, note.filePath, note.rev, Number(note.shared), note.createdAt, note.updatedAt);
  }
  get(id: string): Note | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
    return row ? toNote(row) : undefined;
  }
  list(projectId: string): Note[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at, id').all(projectId) as unknown as Row[];
    return rows.map(toNote);
  }
  update(id: string, { bodyMd, expectedRev, updatedAt }: NoteBodyUpdate): NoteUpdateResult {
    const { changes } = this.db.prepare('UPDATE notes SET body_md = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?')
      .run(bodyMd, updatedAt, id, expectedRev);
    const wasApplied = Number(changes) === 1;

    const current = this.get(id);
    if (!current) return { outcome: 'not_found' };
    if (!wasApplied) return { outcome: 'stale_revision', currentRev: current.rev };
    return { outcome: 'updated', note: current };
  }
  move(id: string, folder: NoteFolder | null): void {
    this.db.prepare('UPDATE notes SET folder = ? WHERE id = ?').run(folder, id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }
}
