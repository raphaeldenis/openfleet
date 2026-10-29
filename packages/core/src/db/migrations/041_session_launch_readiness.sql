ALTER TABLE sessions ADD COLUMN readiness TEXT;
ALTER TABLE sessions ADD COLUMN readiness_reason TEXT;
ALTER TABLE sessions ADD COLUMN launch_retries INTEGER NOT NULL DEFAULT 0;
