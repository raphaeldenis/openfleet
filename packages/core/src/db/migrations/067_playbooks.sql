CREATE TABLE playbooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  flow_json TEXT NOT NULL,
  content_rev INTEGER NOT NULL DEFAULT 1,
  agent_locked INTEGER NOT NULL DEFAULT 0 CHECK (agent_locked IN (0, 1)),
  policy_json TEXT NOT NULL,
  approved_digest TEXT,
  approved_by TEXT,
  approved_at TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('native', 'imported', 'agent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((approved_digest IS NULL) = (approved_by IS NULL) AND (approved_digest IS NULL) = (approved_at IS NULL))
) STRICT;
CREATE INDEX playbooks_by_project ON playbooks(project_id, created_at);
