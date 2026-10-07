import type { DatabaseSync } from 'node:sqlite';

export interface ProjectRecord {
  id: string;
  name: string;
  docsFolderPath: string | null;
  createdAt: string;
  /** Absent when no hook is configured. */
  postCreateHookScript?: string;
  /** Absent when the default applies. */
  postCreateHookTimeoutSeconds?: number;
}

/** A field left out keeps its value; `null` clears the ones that can be cleared. */
export interface ProjectPatch {
  name?: string;
  docsFolderPath?: string;
  postCreateHookScript?: string | null;
  postCreateHookTimeoutSeconds?: number | null;
}

interface Row {
  id: string; name: string; docs_folder_path: string | null; created_at: string;
  post_create_hook_script: string | null; post_create_hook_timeout_seconds: number | null;
}

const toProject = (r: Row): ProjectRecord => ({
  id: r.id, name: r.name, docsFolderPath: r.docs_folder_path, createdAt: r.created_at,
  ...(r.post_create_hook_script !== null && { postCreateHookScript: r.post_create_hook_script }),
  ...(r.post_create_hook_timeout_seconds !== null && { postCreateHookTimeoutSeconds: r.post_create_hook_timeout_seconds }),
});

const keptWhenUndefined = <T>(patched: T | undefined, current: T): T => (patched === undefined ? current : patched);

export class ProjectRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(record: ProjectRecord): void {
    this.db.prepare('INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES (?, ?, ?, ?)')
      .run(record.id, record.name, record.docsFolderPath, record.createdAt);
  }
  update(id: string, patch: ProjectPatch): void {
    const current = this.get(id);
    if (!current) return;
    this.db.prepare('UPDATE projects SET name = ?, docs_folder_path = ?, post_create_hook_script = ?, post_create_hook_timeout_seconds = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.docsFolderPath ?? current.docsFolderPath,
        keptWhenUndefined(patch.postCreateHookScript, current.postCreateHookScript ?? null),
        keptWhenUndefined(patch.postCreateHookTimeoutSeconds, current.postCreateHookTimeoutSeconds ?? null),
        id,
      );
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }
  list(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as Row[]).map(toProject);
  }
}
