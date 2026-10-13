CREATE TABLE governance_proposals (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('law', 'permission', 'resourceAccess')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'withdrawn')),
  incident TEXT NOT NULL CHECK(length(trim(incident)) > 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  denial_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK((status = 'denied') = (denial_reason IS NOT NULL)),
  CHECK((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX governance_proposals_by_manager ON governance_proposals(manager_id, status, created_at);

CREATE TABLE governance_resource_grants (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('dataStore', 'note', 'playbook', 'integration')),
  resource_id TEXT NOT NULL,
  role TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('read', 'readWrite', 'append', 'run', 'use')),
  proposal_id TEXT REFERENCES governance_proposals(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL,
  UNIQUE(manager_id, resource_type, resource_id)
);

ALTER TABLE managers ADD COLUMN governance_evicted_denials INTEGER NOT NULL DEFAULT 0 CHECK(governance_evicted_denials >= 0);
