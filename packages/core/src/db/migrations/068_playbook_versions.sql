CREATE TABLE playbook_versions (
  playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  name TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  flow_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('edit', 'restore')),
  approved_digest TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (playbook_id, rev)
) STRICT;
