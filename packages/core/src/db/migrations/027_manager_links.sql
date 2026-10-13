ALTER TABLE managers ADD COLUMN mission_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL;
ALTER TABLE managers ADD COLUMN pin_mission_note INTEGER NOT NULL DEFAULT 0 CHECK(pin_mission_note IN (0, 1));
ALTER TABLE managers ADD COLUMN log_store_id TEXT REFERENCES data_stores(id) ON DELETE SET NULL;
