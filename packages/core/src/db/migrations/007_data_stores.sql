CREATE TABLE data_stores (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX data_stores_project_name ON data_stores(project_id, display_name);

CREATE TABLE ds_columns (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES data_stores(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  column_type TEXT NOT NULL CHECK(column_type IN ('text', 'number', 'date', 'select', 'json')),
  options_json TEXT CHECK(options_json IS NULL OR json_valid(options_json)),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ds_columns_store_name ON ds_columns(store_id, display_name);

CREATE TABLE ds_rows (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES data_stores(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX ds_rows_store ON ds_rows(store_id);

-- row_id has no foreign key on purpose: a deleted row keeps its history. Only deleting the store removes it.
CREATE TABLE ds_row_history (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES data_stores(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent', 'trigger')),
  actor_label TEXT NOT NULL,
  change_json TEXT NOT NULL CHECK(json_valid(change_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX ds_row_history_row ON ds_row_history(row_id, created_at);
CREATE INDEX ds_row_history_store ON ds_row_history(store_id);

CREATE TABLE ds_views (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES data_stores(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  view_type TEXT NOT NULL CHECK(view_type IN ('grid', 'kanban')),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX ds_views_store ON ds_views(store_id);
