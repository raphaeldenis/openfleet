CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  when_json TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  run_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  content_rev INTEGER NOT NULL DEFAULT 1,
  armed_at TEXT,
  approved_rev INTEGER,
  approved_graph_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((armed_at IS NULL) = (approved_rev IS NULL) AND (armed_at IS NULL) = (approved_graph_digest IS NULL))
) STRICT;
CREATE INDEX triggers_by_project ON triggers(project_id, created_at);

CREATE TABLE trigger_fires (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  ledger_state TEXT NOT NULL CHECK (ledger_state IN ('accepted', 'attempted', 'completed', 'cancelled', 'needs_review')),
  fired_at TEXT NOT NULL,
  settled_at TEXT,
  run_id TEXT,
  event_digest TEXT,
  UNIQUE (trigger_id, dedup_key)
) STRICT;

CREATE TABLE trigger_cursors (
  trigger_id TEXT PRIMARY KEY REFERENCES triggers(id) ON DELETE CASCADE,
  cursor_json TEXT NOT NULL
) STRICT;
