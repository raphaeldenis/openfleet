ALTER TABLE ds_columns ADD COLUMN required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1));
ALTER TABLE ds_columns ADD COLUMN display_column_id TEXT;
ALTER TABLE ds_columns ADD COLUMN config_json TEXT CHECK(config_json IS NULL OR (json_valid(config_json) AND json_type(config_json) = 'object'));
ALTER TABLE ds_columns ADD COLUMN display_width INTEGER CHECK(display_width IS NULL OR display_width BETWEEN 60 AND 1200);
ALTER TABLE ds_columns ADD COLUMN wrap_mode TEXT CHECK(wrap_mode IS NULL OR wrap_mode = 'wrap');
ALTER TABLE ds_columns ADD COLUMN wrap_max_lines INTEGER CHECK(wrap_max_lines IS NULL OR (wrap_mode IS NOT NULL AND wrap_max_lines BETWEEN 1 AND 100));
