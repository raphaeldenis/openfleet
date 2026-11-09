CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('token')),
  allowed_hosts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE integration_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  resource TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
) STRICT;
CREATE INDEX integration_profiles_by_connection ON integration_profiles(connection_id);

CREATE TABLE integration_health (
  profile_id TEXT PRIMARY KEY REFERENCES integration_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'auth_failed', 'unreachable', 'rate_limited')),
  checked_at TEXT NOT NULL
) STRICT;
