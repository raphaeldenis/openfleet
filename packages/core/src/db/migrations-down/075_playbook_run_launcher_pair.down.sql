-- Restores the shape of 074: the launcher columns without the CHECK on the pair, the kind CHECK on its column, and the guard. No run, step or manual request is lost.
CREATE TABLE playbook_run_steps_kept AS SELECT * FROM playbook_run_steps;
CREATE TABLE playbook_manual_requests_kept AS SELECT * FROM playbook_manual_requests;
DROP TABLE playbook_manual_requests;
DROP TABLE playbook_run_steps;

CREATE TABLE playbook_runs_without_launcher_pair (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  playbook_rev INTEGER NOT NULL,
  flow_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_manual', 'succeeded', 'failed', 'needs_review')),
  inputs_json TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  launched_by_kind TEXT CHECK (launched_by_kind IN ('admin_api', 'trigger', 'unknown')),
  launched_by_ref TEXT,
  CHECK ((status IN ('running', 'waiting_manual')) = (ended_at IS NULL))
) STRICT;
INSERT INTO playbook_runs_without_launcher_pair (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, error_code, started_at, ended_at, launched_by_kind, launched_by_ref)
SELECT id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, error_code, started_at, ended_at, launched_by_kind, launched_by_ref FROM playbook_runs;
DROP TABLE playbook_runs;
ALTER TABLE playbook_runs_without_launcher_pair RENAME TO playbook_runs;
CREATE INDEX playbook_runs_by_playbook ON playbook_runs(playbook_id, started_at);
CREATE INDEX playbook_runs_by_status ON playbook_runs(status);

CREATE TRIGGER playbook_runs_launcher_fixed_at_creation
BEFORE UPDATE OF launched_by_kind, launched_by_ref ON playbook_runs BEGIN
  SELECT RAISE(ABORT, 'the launcher of a playbook run is fixed at creation');
END;

CREATE TABLE playbook_run_steps (
  run_id TEXT NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_manual', 'succeeded', 'failed', 'needs_review')),
  output_json_masked TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (run_id, seq),
  CHECK ((status IN ('running', 'waiting_manual')) = (ended_at IS NULL))
) STRICT;
INSERT INTO playbook_run_steps (run_id, seq, step_id, status, output_json_masked, error_code, started_at, ended_at)
SELECT run_id, seq, step_id, status, output_json_masked, error_code, started_at, ended_at FROM playbook_run_steps_kept;
DROP TABLE playbook_run_steps_kept;

CREATE TABLE playbook_manual_requests (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  prompt_masked TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
  decision TEXT CHECK (decision IN ('approved', 'rejected')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id, seq) REFERENCES playbook_run_steps(run_id, seq) ON DELETE CASCADE,
  CHECK ((status = 'pending') = (settled_at IS NULL)),
  CHECK ((status = 'answered') = (decision IS NOT NULL))
) STRICT;
INSERT INTO playbook_manual_requests (run_id, seq, prompt_masked, status, decision, requested_at, expires_at, settled_at)
SELECT run_id, seq, prompt_masked, status, decision, requested_at, expires_at, settled_at FROM playbook_manual_requests_kept;
DROP TABLE playbook_manual_requests_kept;
CREATE INDEX playbook_manual_requests_pending ON playbook_manual_requests(status, expires_at);
