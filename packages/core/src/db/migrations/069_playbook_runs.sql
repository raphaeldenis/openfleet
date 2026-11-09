ALTER TABLE playbooks ADD COLUMN approved_scripts_json TEXT;

CREATE TABLE playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  playbook_rev INTEGER NOT NULL,
  flow_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'needs_review')),
  inputs_json TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((status = 'running') = (ended_at IS NULL))
) STRICT;
CREATE INDEX playbook_runs_by_playbook ON playbook_runs(playbook_id, started_at);
CREATE INDEX playbook_runs_by_status ON playbook_runs(status);

CREATE TABLE playbook_run_steps (
  run_id TEXT NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'needs_review')),
  output_json_masked TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (run_id, seq),
  CHECK ((status = 'running') = (ended_at IS NULL))
) STRICT;
