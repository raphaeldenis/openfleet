CREATE TABLE handovers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK(kind IN ('design_link', 'doc_path')),
  value TEXT NOT NULL CHECK(value <> '' AND length(value) <= 500),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX handovers_session_value ON handovers(session_id, value);
