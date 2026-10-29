CREATE TABLE watched_prs (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  last_notified_sha TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (manager_id, repo, number)
) STRICT;
CREATE INDEX watched_prs_by_status ON watched_prs(status, manager_id);
