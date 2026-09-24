ALTER TABLE sessions ADD COLUMN permission_mode TEXT;

CREATE TABLE managers (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  pulse_seconds INTEGER NOT NULL,
  children_cap INTEGER NOT NULL,
  mission_text TEXT NOT NULL,
  last_pulse_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
