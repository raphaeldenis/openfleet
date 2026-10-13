ALTER TABLE managers ADD COLUMN pulse_enabled INTEGER NOT NULL DEFAULT 1 CHECK(pulse_enabled IN (0, 1));
