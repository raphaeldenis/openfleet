CREATE TABLE knowledge_repositories (
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_key TEXT NOT NULL CHECK(length(trim(repo_key)) BETWEEN 1 AND 128),
  canonical_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'postgres'
    CHECK(authority IN ('postgres', 'frozen', 'native')),
  frozen_at TEXT,
  final_snapshot_id TEXT,
  activated_at TEXT,
  PRIMARY KEY (project_id, repo_key),
  UNIQUE (project_id, git_common_dir),
  CHECK(authority = 'postgres' OR frozen_at IS NOT NULL),
  CHECK(authority <> 'native' OR
    (final_snapshot_id IS NOT NULL AND activated_at IS NOT NULL))
) STRICT;

CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  area TEXT NOT NULL CHECK(length(trim(area)) > 0),
  fact TEXT NOT NULL CHECK(length(trim(fact)) > 0),
  source_task TEXT,
  source_kind TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_why TEXT,
  FOREIGN KEY (project_id, repo_key)
    REFERENCES knowledge_repositories(project_id, repo_key),
  CHECK(retired_at IS NOT NULL OR retired_why IS NULL)
) STRICT;

CREATE INDEX knowledge_active_scope
  ON knowledge(project_id, repo_key, created_at DESC, id)
  WHERE retired_at IS NULL;
CREATE INDEX knowledge_scope_area
  ON knowledge(project_id, repo_key, area, created_at DESC, id);
CREATE INDEX knowledge_source_task
  ON knowledge(project_id, repo_key, source_task)
  WHERE source_task IS NOT NULL;

CREATE VIEW active_knowledge AS
  SELECT id, project_id, repo_key, area, fact,
         source_task, source_kind, verified_by, created_at
  FROM knowledge
  WHERE retired_at IS NULL;

CREATE TABLE knowledge_import_entries (
  project_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL UNIQUE REFERENCES knowledge(id),
  imported_fingerprint TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  PRIMARY KEY (project_id, repo_key, source_id),
  FOREIGN KEY (project_id, repo_key)
    REFERENCES knowledge_repositories(project_id, repo_key)
) STRICT;

CREATE TABLE knowledge_import_runs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  source_rows INTEGER NOT NULL CHECK(source_rows >= 0),
  inserted INTEGER NOT NULL CHECK(inserted >= 0),
  updated INTEGER NOT NULL CHECK(updated >= 0),
  unchanged INTEGER NOT NULL CHECK(unchanged >= 0),
  retired INTEGER NOT NULL CHECK(retired >= 0)
) STRICT;

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  area, fact,
  content='knowledge',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, area, fact)
  VALUES (new.rowid, new.area, new.fact);
END;

CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, area, fact)
  VALUES ('delete', old.rowid, old.area, old.fact);
END;

CREATE TRIGGER knowledge_fts_au
AFTER UPDATE OF area, fact ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, area, fact)
  VALUES ('delete', old.rowid, old.area, old.fact);
  INSERT INTO knowledge_fts(rowid, area, fact)
  VALUES (new.rowid, new.area, new.fact);
END;
