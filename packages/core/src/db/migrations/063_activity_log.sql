CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent', 'system')),
  actor_label TEXT NOT NULL,
  session_id TEXT,
  manager_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('mcp', 'rest', 'hook', 'daemon')),
  action TEXT NOT NULL,
  entity_kind TEXT,
  entity_id TEXT,
  entity_label TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'denied', 'gated', 'error')),
  duration_ms INTEGER,
  detail TEXT,
  args_excerpt TEXT,
  result_excerpt TEXT
);
CREATE INDEX activity_log_by_time ON activity_log(at DESC);
CREATE INDEX activity_log_by_session ON activity_log(session_id, at);
CREATE INDEX activity_log_by_manager ON activity_log(manager_id, at);
CREATE INDEX activity_log_by_action ON activity_log(action, at);
