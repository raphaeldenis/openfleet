CREATE TABLE denied_commands (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  role TEXT,
  profile TEXT NOT NULL,
  harness TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  decision_source TEXT NOT NULL CHECK(decision_source IN ('policy', 'cli_ask')),
  outcome TEXT NOT NULL CHECK(outcome IN ('denied', 'observed')),
  tool_name TEXT NOT NULL,
  command_excerpt TEXT NOT NULL CHECK(length(command_excerpt) <= 200),
  alternative TEXT,
  actor TEXT NOT NULL CHECK(actor IN ('session', 'subagent')),
  created_at TEXT NOT NULL
);
CREATE INDEX denied_commands_by_manager ON denied_commands(manager_id, created_at);
CREATE INDEX denied_commands_by_session ON denied_commands(session_id, rule_id, created_at);
