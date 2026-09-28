CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  folder TEXT,
  file_path TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  shared INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX notes_project_folder ON notes(project_id, folder);
CREATE UNIQUE INDEX notes_file_path ON notes(file_path) WHERE file_path IS NOT NULL;

CREATE TABLE note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  author TEXT NOT NULL,
  change_summary TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX note_versions_note_rev ON note_versions(note_id, rev);

CREATE VIRTUAL TABLE note_fts USING fts5(note_id UNINDEXED, title, body_md);

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO note_fts(note_id, title, body_md) VALUES (new.id, new.title, new.body_md);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
  DELETE FROM note_fts WHERE note_id = old.id;
  INSERT INTO note_fts(note_id, title, body_md) VALUES (new.id, new.title, new.body_md);
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM note_fts WHERE note_id = old.id;
END;
