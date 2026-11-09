CREATE TABLE integration_view_configs (
  profile_id TEXT PRIMARY KEY REFERENCES integration_profiles(id) ON DELETE CASCADE,
  jql TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  content_rev INTEGER NOT NULL CHECK (content_rev >= 1),
  approved_rev INTEGER CHECK (approved_rev IS NULL OR approved_rev >= 1),
  approved_digest TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((approved_rev IS NULL) = (approved_digest IS NULL) AND (approved_rev IS NULL) = (approved_at IS NULL))
) STRICT;
