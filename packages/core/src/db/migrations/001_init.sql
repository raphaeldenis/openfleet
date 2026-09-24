CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  directory TEXT NOT NULL,
  worktree TEXT,
  model TEXT,
  parent_id TEXT REFERENCES sessions(id),
  role TEXT,
  harness TEXT NOT NULL,
  state TEXT NOT NULL,
  state_since TEXT NOT NULL,
  exit_code INTEGER,
  hook_token TEXT NOT NULL UNIQUE,
  mcp_token TEXT NOT NULL UNIQUE,
  claude_session_id TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE TABLE message_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  from_session_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;
CREATE INDEX message_queue_pending ON message_queue(session_id, status, created_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  payload_json TEXT,
  ts TEXT NOT NULL
) STRICT;
