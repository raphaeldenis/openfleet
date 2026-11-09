CREATE TABLE integration_poll_state (
  profile_id TEXT PRIMARY KEY REFERENCES integration_profiles(id) ON DELETE CASCADE,
  etag TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  next_poll_at TEXT NOT NULL,
  last_polled_at TEXT NOT NULL
) STRICT;

CREATE TABLE integration_connection_polling (
  connection_id TEXT PRIMARY KEY REFERENCES integration_connections(id) ON DELETE CASCADE,
  consecutive_auth_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_auth_failures >= 0),
  is_stopped INTEGER NOT NULL DEFAULT 0 CHECK (is_stopped IN (0, 1))
) STRICT;

CREATE TABLE integration_view_items (
  profile_id TEXT NOT NULL REFERENCES integration_profiles(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, external_id)
) STRICT;
