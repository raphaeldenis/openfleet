ALTER TABLE sessions ADD COLUMN resolved_model TEXT;
ALTER TABLE sessions ADD COLUMN cli_version TEXT;
ALTER TABLE sessions ADD COLUMN model_drifted_from TEXT;
