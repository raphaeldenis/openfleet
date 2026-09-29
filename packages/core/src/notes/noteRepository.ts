import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Note, NoteFolder, NoteVersion } from '@openfleet/shared';

export type NoteUpdateResult =
  | { outcome: 'updated'; note: Note }
  | { outcome: 'stale_revision'; currentRev: number }
  | { outcome: 'not_found' };

export interface NoteBodyUpdate {
  bodyMd: string;
  expectedRev: number;
  updatedAt: string;
}

export interface NoteFileBackedUpdate {
  bodyMd: string;
  sourceHash: string;
  expectedRev: number;
  updatedAt: string;
}

export interface NoteTitleUpdate {
  title: string;
  expectedRev: number;
  updatedAt: string;
}

export interface NoteVersionInsert {
  id: string;
  noteId: string;
  rev: number;
  bodyMd: string;
  author: string;
  createdAt: string;
}

interface Row {
  id: string; project_id: string; title: string; body_md: string; folder: NoteFolder | null;
  file_path: string | null; source_hash: string | null; rev: number; shared: number; created_at: string; updated_at: string;
}

interface VersionRow {
  id: string; note_id: string; rev: number; body_md: string; author: string; change_summary: string | null; created_at: string;
}

const toNote = (r: Row): Note => ({
  id: r.id, projectId: r.project_id, title: r.title, bodyMd: r.body_md, folder: r.folder,
  filePath: r.file_path, sourceHash: r.source_hash, rev: r.rev, shared: r.shared === 1, createdAt: r.created_at, updatedAt: r.updated_at,
});

const toNoteVersion = (r: VersionRow): NoteVersion => ({
  id: r.id, noteId: r.note_id, rev: r.rev, bodyMd: r.body_md, author: r.author, changeSummary: r.change_summary, createdAt: r.created_at,
});

export class NoteRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(note: Note): void {
    this.db.prepare(`INSERT INTO notes (id, project_id, title, body_md, folder, file_path, source_hash, rev, shared, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(note.id, note.projectId, note.title, note.bodyMd, note.folder, note.filePath, note.sourceHash, note.rev, Number(note.shared), note.createdAt, note.updatedAt);
  }
  get(id: string): Note | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
    return row ? toNote(row) : undefined;
  }
  getByFilePath(filePath: string): Note | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE file_path = ?').get(filePath) as Row | undefined;
    return row ? toNote(row) : undefined;
  }
  list(projectId: string): Note[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at, id').all(projectId) as unknown as Row[];
    return rows.map(toNote);
  }
  update(id: string, { bodyMd, expectedRev, updatedAt }: NoteBodyUpdate): NoteUpdateResult {
    return this.compareAndSet(
      'UPDATE notes SET body_md = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? RETURNING *',
      [bodyMd, updatedAt], id, expectedRev,
    );
  }
  /** Same rev compare-and-set as `update`, but also stamps `source_hash` — the one UPDATE a file-backed write commits (Review Focus 5). */
  updateFileBacked(id: string, { bodyMd, sourceHash, expectedRev, updatedAt }: NoteFileBackedUpdate): NoteUpdateResult {
    return this.compareAndSet(
      'UPDATE notes SET body_md = ?, source_hash = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? RETURNING *',
      [bodyMd, sourceHash, updatedAt], id, expectedRev,
    );
  }
  rename(id: string, { title, expectedRev, updatedAt }: NoteTitleUpdate): NoteUpdateResult {
    return this.compareAndSet(
      'UPDATE notes SET title = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? RETURNING *',
      [title, updatedAt], id, expectedRev,
    );
  }
  move(id: string, folder: NoteFolder | null): boolean {
    const { changes } = this.db.prepare('UPDATE notes SET folder = ? WHERE id = ?').run(folder, id);
    return Number(changes) > 0;
  }
  delete(id: string): boolean {
    const { changes } = this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return Number(changes) > 0;
  }
  insertVersion({ id, noteId, rev, bodyMd, author, createdAt }: NoteVersionInsert): void {
    this.db.prepare(`INSERT INTO note_versions (id, note_id, rev, body_md, author, change_summary, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(id, noteId, rev, bodyMd, author, createdAt);
  }
  listVersions(noteId: string): NoteVersion[] {
    const rows = this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY rev').all(noteId) as unknown as VersionRow[];
    return rows.map(toNoteVersion);
  }

  private compareAndSet(sql: string, params: SQLInputValue[], id: string, expectedRev: number): NoteUpdateResult {
    const updatedRow = this.db.prepare(sql).get(...params, id, expectedRev) as Row | undefined;
    if (updatedRow) return { outcome: 'updated', note: toNote(updatedRow) };

    const current = this.get(id);
    return current ? { outcome: 'stale_revision', currentRev: current.rev } : { outcome: 'not_found' };
  }
}
