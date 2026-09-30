ALTER TABLE sessions ADD COLUMN prompted INTEGER NOT NULL DEFAULT 0;

UPDATE sessions SET prompted = 1 WHERE cli_session_id IS NOT NULL AND cli_session_id <> id;

CREATE INDEX IF NOT EXISTS session_events_by_session_kind_ts ON session_events (session_id, kind, ts);
