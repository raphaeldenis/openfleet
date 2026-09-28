CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  docs_folder_path TEXT,
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX sessions_project ON sessions(project_id);
