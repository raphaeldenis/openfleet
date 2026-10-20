CREATE TABLE laws (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK(length(trim(text)) > 0 AND length(text) <= 2000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'withdrawn')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  withdrawn_at TEXT,
  approved_by TEXT,
  updated_by TEXT,
  withdrawn_by TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('proposal', 'legacy', 'import')),
  source_key TEXT UNIQUE,
  source_created_at TEXT,
  proposal_id TEXT UNIQUE REFERENCES governance_proposals(id) ON DELETE SET NULL,
  CHECK((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK((status = 'withdrawn') = (withdrawn_by IS NOT NULL)),
  CHECK(source_kind = 'legacy' OR length(trim(coalesce(approved_by, ''))) > 0),
  CHECK((source_kind = 'proposal') = (source_key IS NULL))
) STRICT;
CREATE INDEX laws_by_manager ON laws(manager_id, status, id);

-- Every approved law the proposal history still holds becomes a legacy law (author unknown, dated at its decision). Idempotent.
INSERT INTO laws (id, manager_id, text, status, revision, created_at, updated_at, source_kind, source_key, source_created_at, proposal_id)
SELECT lower(hex(randomblob(16))), p.manager_id, json_extract(p.payload_json, '$.text'), 'active', 1, p.decided_at, p.decided_at, 'legacy', 'legacy-proposal:' || p.id, p.created_at, p.id
FROM governance_proposals p
WHERE p.kind = 'law' AND p.status = 'approved'
  AND json_type(p.payload_json, '$.text') = 'text'
  AND length(trim(json_extract(p.payload_json, '$.text'))) > 0
  AND length(json_extract(p.payload_json, '$.text')) <= 2000
  AND NOT EXISTS (SELECT 1 FROM laws l WHERE l.proposal_id = p.id OR l.source_key = 'legacy-proposal:' || p.id)
ORDER BY p.id;
