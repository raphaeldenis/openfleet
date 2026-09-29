import type { DatabaseSync } from 'node:sqlite';

export interface ProjectRecord {
  id: string;
  name: string;
  docsFolderPath: string | null;
  createdAt: string;
}

interface Row { id: string; name: string; docs_folder_path: string | null; created_at: string }

const toProject = (r: Row): ProjectRecord => ({
  id: r.id, name: r.name, docsFolderPath: r.docs_folder_path, createdAt: r.created_at,
});

export class ProjectRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insert(record: ProjectRecord): void {
    this.db.prepare('INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES (?, ?, ?, ?)')
      .run(record.id, record.name, record.docsFolderPath, record.createdAt);
  }
  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }
  list(): ProjectRecord[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as Row[]).map(toProject);
  }
}
