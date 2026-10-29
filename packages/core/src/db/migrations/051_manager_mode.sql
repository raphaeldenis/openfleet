ALTER TABLE managers ADD COLUMN mode TEXT NOT NULL DEFAULT 'watching' CHECK(mode IN ('watching', 'sleeping', 'disabled'));
ALTER TABLE managers ADD COLUMN mode_changed_at TEXT;
ALTER TABLE managers ADD COLUMN sleep_handoff_pending INTEGER NOT NULL DEFAULT 0 CHECK(sleep_handoff_pending IN (0, 1));
ALTER TABLE managers ADD COLUMN sleep_handoff_delivered_at TEXT;
UPDATE managers SET mode = 'sleeping' WHERE pulse_enabled = 0;
