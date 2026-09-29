ALTER TABLE sessions ADD COLUMN resolved_for_model TEXT;
UPDATE sessions SET resolved_for_model = model WHERE resolved_model IS NOT NULL;
