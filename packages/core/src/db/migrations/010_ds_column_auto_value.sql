ALTER TABLE ds_columns ADD COLUMN auto_value TEXT CHECK(auto_value IS NULL OR auto_value = 'created_at');
