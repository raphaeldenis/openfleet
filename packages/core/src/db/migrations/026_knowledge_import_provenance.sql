ALTER TABLE knowledge_import_runs ADD COLUMN snapshot_digest TEXT
  CHECK(snapshot_digest IS NULL OR
    (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE knowledge_import_runs ADD COLUMN mem02_acceptance TEXT;

CREATE TABLE knowledge_import_mappings (
  run_id TEXT NOT NULL REFERENCES knowledge_import_runs(id),
  source_repo TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  PRIMARY KEY (run_id, source_repo),
  UNIQUE (run_id, project_id, repo_key),
  FOREIGN KEY (project_id, repo_key)
    REFERENCES knowledge_repositories(project_id, repo_key)
) STRICT;

CREATE INDEX knowledge_import_mapping_source ON knowledge_import_mappings(source_repo);
CREATE INDEX knowledge_import_snapshot_digest ON knowledge_import_runs(snapshot_digest);

CREATE TABLE knowledge_current_seals (
  project_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES knowledge_import_runs(id),
  PRIMARY KEY (project_id, repo_key),
  FOREIGN KEY (project_id, repo_key)
    REFERENCES knowledge_repositories(project_id, repo_key)
) STRICT;
