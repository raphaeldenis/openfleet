CREATE TABLE secret_refs (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('playbook', 'connection', 'trigger')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('stored', 'missing')),
  set_at TEXT,
  set_by TEXT,
  UNIQUE(scope_kind, scope_id, name)
);
