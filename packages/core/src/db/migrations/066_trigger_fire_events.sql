ALTER TABLE trigger_fires ADD COLUMN event_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE trigger_fires ADD COLUMN settle_reason TEXT;
ALTER TABLE trigger_fires ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trigger_fires ADD COLUMN effect_started_at TEXT;
ALTER TABLE triggers ADD COLUMN owner_manager_id TEXT;
