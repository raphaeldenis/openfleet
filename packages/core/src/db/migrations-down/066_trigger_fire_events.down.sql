ALTER TABLE triggers DROP COLUMN owner_manager_id;
ALTER TABLE trigger_fires DROP COLUMN effect_started_at;
ALTER TABLE trigger_fires DROP COLUMN chain_depth;
ALTER TABLE trigger_fires DROP COLUMN settle_reason;
ALTER TABLE trigger_fires DROP COLUMN event_json;
