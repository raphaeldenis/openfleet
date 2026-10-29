ALTER TABLE managers ADD COLUMN child_auto_restart INTEGER NOT NULL DEFAULT 0 CHECK(child_auto_restart IN (0, 1));
CREATE TABLE child_restarts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at TEXT NOT NULL
);
CREATE INDEX child_restarts_by_session ON child_restarts(session_id, at);
