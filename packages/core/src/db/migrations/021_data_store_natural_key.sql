-- No foreign key: the importer writes a store before its columns. The service only accepts a text column of the same store.
ALTER TABLE data_stores ADD COLUMN natural_key_column_id TEXT CHECK(natural_key_column_id IS NULL OR natural_key_column_id <> '');
