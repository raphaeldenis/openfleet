CREATE TABLE child_silence_checks (
  child_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  manager_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  armed_at TEXT NOT NULL,
  due_at TEXT NOT NULL
) STRICT;
