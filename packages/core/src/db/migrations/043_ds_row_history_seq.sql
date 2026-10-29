-- ds_row_history gains `seq`, a stable position: an INTEGER PRIMARY KEY AUTOINCREMENT is never renumbered by VACUUM nor reused after a delete.
-- Existing entries are numbered in their current reading order (created_at, then implicit rowid). Nothing references ds_row_history, so the rebuild cascades nowhere.
CREATE TABLE ds_row_history_with_seq (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES data_stores(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL CHECK(row_id <> ''),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent', 'trigger')),
  actor_label TEXT NOT NULL CHECK(actor_label <> ''),
  change_json TEXT NOT NULL CHECK(json_valid(change_json) AND json_type(change_json) = 'object'),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO ds_row_history_with_seq (id, store_id, row_id, actor_kind, actor_label, change_json, created_at)
SELECT id, store_id, row_id, actor_kind, actor_label, change_json, created_at FROM ds_row_history ORDER BY created_at, rowid;

DROP TABLE ds_row_history;
ALTER TABLE ds_row_history_with_seq RENAME TO ds_row_history;

CREATE INDEX ds_row_history_row ON ds_row_history(row_id, created_at);
CREATE INDEX ds_row_history_store ON ds_row_history(store_id);
