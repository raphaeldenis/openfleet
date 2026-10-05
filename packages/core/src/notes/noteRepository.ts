import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Note, NoteFolder, NoteSummary, NoteVersion } from '@openfleet/shared';

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

export interface NoteFolderUpdate {
  folder: NoteFolder | null;
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

export type NoteVersionSummary = Pick<NoteVersion, 'id' | 'rev' | 'author' | 'createdAt'>;

export interface NoteSearchHit {
  note: Note;
  snippet: string;
}

export interface NoteSummaryHit {
  note: NoteSummary;
  snippet: string;
}

export interface NoteListOptions {
  folder?: NoteFolder;
  limit: number;
  offset: number;
}

export interface HandoffFileRecord {
  id: string;
  filePath: string;
  title: string;
  updatedAt: string;
}

interface HandoffFileRow { id: string; file_path: string; title: string; updated_at: string }
const handoffFileOf = (row: HandoffFileRow): HandoffFileRecord => ({ id: row.id, filePath: row.file_path, title: row.title, updatedAt: row.updated_at });

export interface NoteSearchOptions {
  projectId: string;
  limit: number;
  offset?: number;
}

interface Row {
  id: string; project_id: string; title: string; body_md: string; folder: NoteFolder | null;
  file_path: string | null; source_hash: string | null; rev: number; shared: number; created_at: string; updated_at: string;
}

interface VersionRow {
  id: string; note_id: string; rev: number; body_md: string; author: string; change_summary: string | null; created_at: string;
}

interface SummaryRow {
  id: string; title: string; folder: NoteFolder | null; rev: number; shared: number; is_file_backed: number; updated_at: string;
}

const SUMMARY_COLUMNS = 'id, title, folder, rev, shared, file_path IS NOT NULL AS is_file_backed, updated_at';

const toSummary = (r: SummaryRow): NoteSummary => ({
  id: r.id, title: r.title, folder: r.folder, rev: r.rev, shared: r.shared === 1, fileBacked: r.is_file_backed === 1, updatedAt: r.updated_at,
});

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
  /** Ownership lookup that never loads the body. */
  getProjectId(id: string): string | undefined {
    const row = this.db.prepare('SELECT project_id FROM notes WHERE id = ?').get(id) as { project_id: string } | undefined;
    return row?.project_id;
  }
  getByFilePath(filePath: string): Note | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE file_path = ?').get(filePath) as Row | undefined;
    return row ? toNote(row) : undefined;
  }
  list(projectId: string): Note[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at, id').all(projectId) as unknown as Row[];
    return rows.map(toNote);
  }
  listHandoffFiles(projectId: string, { limit, offset }: { limit: number; offset: number }): HandoffFileRecord[] {
    const rows = this.db.prepare(`SELECT id, file_path, title, updated_at FROM notes
      WHERE project_id = ? AND folder = 'handoffs' AND file_path IS NOT NULL
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(projectId, limit, offset) as unknown as HandoffFileRow[];
    return rows.map(handoffFileOf);
  }
  countHandoffFiles(projectId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE project_id = ? AND folder = 'handoffs' AND file_path IS NOT NULL").get(projectId) as { n: number };
    return row.n;
  }
  findHandoffFile({ projectId, file }: { projectId: string; file: string }): HandoffFileRecord | undefined {
    const suffix = `/${file}`;
    const row = this.db.prepare(`SELECT id, file_path, title, updated_at FROM notes
      WHERE project_id = ? AND folder = 'handoffs' AND substr(file_path, -?) = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1`).get(projectId, suffix.length, suffix) as HandoffFileRow | undefined;
    return row ? handoffFileOf(row) : undefined;
  }
  /** One page of summaries, bodies never read; `folder` narrows the page. */
  listSummaries(projectId: string, { folder, limit, offset }: NoteListOptions): NoteSummary[] {
    const rows = this.db.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM notes WHERE project_id = ? AND (? IS NULL OR folder = ?) ORDER BY created_at, id LIMIT ? OFFSET ?`,
    ).all(projectId, folder ?? null, folder ?? null, limit, offset) as unknown as SummaryRow[];
    return rows.map(toSummary);
  }
  /** The first `limit` summaries of the notes filed in no folder. */
  listUnfiledSummaries(projectId: string, limit: number): NoteSummary[] {
    const rows = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM notes WHERE project_id = ? AND folder IS NULL ORDER BY created_at, id LIMIT ?`)
      .all(projectId, limit) as unknown as SummaryRow[];
    return rows.map(toSummary);
  }
  count(projectId: string, folder?: NoteFolder): number {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE project_id = ? AND (? IS NULL OR folder = ?)')
      .get(projectId, folder ?? null, folder ?? null) as { n: number };
    return n;
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
  updateBodyAndTitle(id: string, { bodyMd, title, expectedRev, updatedAt }: NoteBodyUpdate & { title: string }): NoteUpdateResult {
    return this.compareAndSet(
      'UPDATE notes SET body_md = ?, title = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? RETURNING *',
      [bodyMd, title, updatedAt], id, expectedRev,
    );
  }
  move(id: string, { folder, expectedRev, updatedAt }: NoteFolderUpdate): NoteUpdateResult {
    return this.compareAndSet(
      'UPDATE notes SET folder = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? RETURNING *',
      [folder, updatedAt], id, expectedRev,
    );
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
  getVersion(noteId: string, rev: number): NoteVersion | undefined {
    const row = this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? AND rev = ?').get(noteId, rev) as VersionRow | undefined;
    return row ? toNoteVersion(row) : undefined;
  }
  /** History without bodies: what a listing needs, without reading every revision's full text. Unbounded unless `page` is given. */
  listVersionSummaries(noteId: string, page: { limit: number; offset: number } = { limit: -1, offset: 0 }): NoteVersionSummary[] {
    const rows = this.db.prepare('SELECT id, rev, author, created_at FROM note_versions WHERE note_id = ? ORDER BY rev LIMIT ? OFFSET ?')
      .all(noteId, page.limit, page.offset) as unknown as Pick<VersionRow, 'id' | 'rev' | 'author' | 'created_at'>[];
    return rows.map((row) => ({ id: row.id, rev: row.rev, author: row.author, createdAt: row.created_at }));
  }
  countVersions(noteId: string): number {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?').get(noteId) as { n: number };
    return n;
  }
  /** Same match as `search`, but reads only summary columns: no body is loaded. */
  searchSummaries(escapedQuery: string, { projectId, limit, offset = 0 }: NoteSearchOptions): NoteSummaryHit[] {
    const rows = this.db.prepare(
      `SELECT n.id, n.title, n.folder, n.rev, n.shared, n.file_path IS NOT NULL AS is_file_backed, n.updated_at,
              snippet(note_fts, 2, '', '', '…', 12) AS snippet
       FROM notes n JOIN note_fts ON note_fts.note_id = n.id
       WHERE note_fts MATCH ? AND n.project_id = ?
       ORDER BY rank, n.id
       LIMIT ? OFFSET ?`,
    ).all(escapedQuery, projectId, limit, offset) as unknown as (SummaryRow & { snippet: string })[];
    return rows.map((row) => ({ note: toSummary(row), snippet: row.snippet }));
  }
  countSearchMatches(escapedQuery: string, projectId: string): number {
    const { n } = this.db.prepare(
      `SELECT COUNT(*) AS n FROM notes n JOIN note_fts ON note_fts.note_id = n.id WHERE note_fts MATCH ? AND n.project_id = ?`,
    ).get(escapedQuery, projectId) as { n: number };
    return n;
  }
  /** `escapedQuery` must already be FTS5-safe (see noteTools.ts's query escaping) — this method trusts it verbatim. */
  search(escapedQuery: string, { projectId, limit }: NoteSearchOptions): NoteSearchHit[] {
    const rows = this.db.prepare(
      `SELECT n.*, snippet(note_fts, 2, '', '', '…', 12) AS snippet
       FROM notes n JOIN note_fts ON note_fts.note_id = n.id
       WHERE note_fts MATCH ? AND n.project_id = ?
       ORDER BY rank, n.id
       LIMIT ?`,
    ).all(escapedQuery, projectId, limit) as unknown as (Row & { snippet: string })[];
    return rows.map((row) => ({ note: toNote(row), snippet: row.snippet }));
  }

  private compareAndSet(sql: string, params: SQLInputValue[], id: string, expectedRev: number): NoteUpdateResult {
    const updatedRow = this.db.prepare(sql).get(...params, id, expectedRev) as Row | undefined;
    if (updatedRow) return { outcome: 'updated', note: toNote(updatedRow) };

    const current = this.get(id);
    return current ? { outcome: 'stale_revision', currentRev: current.rev } : { outcome: 'not_found' };
  }
}
