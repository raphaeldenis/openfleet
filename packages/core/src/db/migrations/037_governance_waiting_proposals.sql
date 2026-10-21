-- The proposals a manager filed beyond its pending places wait here, in filing order (created_at, then rowid).
-- A separate table: governance_proposals keeps its statuses, and laws.proposal_id / governance_resource_grants.proposal_id keep pointing at it.
CREATE TABLE governance_waiting_proposals (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('law', 'permission', 'resourceAccess')),
  incident TEXT NOT NULL CHECK(length(trim(incident)) > 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX governance_waiting_by_manager ON governance_waiting_proposals(manager_id, created_at);  -- SQLite appends the rowid to every index entry: the order is (manager_id, created_at, rowid)
