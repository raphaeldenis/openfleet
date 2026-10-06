ALTER TABLE ds_columns ADD COLUMN column_format TEXT CHECK(
  column_format IS NULL
  OR (column_format = 'datetime' AND column_type = 'date')
  OR (column_format IN ('longText', 'url') AND column_type = 'text')
  OR (column_format = 'rank' AND column_type = 'number')
);
