CREATE TABLE integration_view_configs (
  profile_id TEXT PRIMARY KEY REFERENCES integration_profiles(id) ON DELETE CASCADE,
  content_rev INTEGER NOT NULL CHECK (content_rev >= 1),
  pending_jql TEXT,
  pending_fields_json TEXT,
  active_jql TEXT,
  active_fields_json TEXT,
  approved_rev INTEGER CHECK (approved_rev IS NULL OR approved_rev >= 1),
  approved_digest TEXT,
  approved_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((pending_jql IS NULL) = (pending_fields_json IS NULL)),
  CHECK (
    (active_jql IS NULL) = (active_fields_json IS NULL)
    AND (active_jql IS NULL) = (approved_rev IS NULL)
    AND (active_jql IS NULL) = (approved_digest IS NULL)
    AND (active_jql IS NULL) = (approved_at IS NULL)
  )
) STRICT;
