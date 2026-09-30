ALTER TABLE sessions ADD COLUMN prompted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS session_events_by_session_kind_ts ON session_events (session_id, kind, ts);
