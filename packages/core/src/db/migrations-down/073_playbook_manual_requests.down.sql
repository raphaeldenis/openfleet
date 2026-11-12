-- Restores the status CHECKs of 069. A run or a step that waits for a human has no place there: it becomes needs_review with the code `interrupted`,
-- the state a step left running by a stopped daemon gets, so the wait is examined by a person and nothing is lost or silently resumed.
DROP TABLE playbook_manual_requests;

CREATE TABLE playbook_run_steps_kept AS SELECT * FROM playbook_run_steps;
DROP TABLE playbook_run_steps;

CREATE TABLE playbook_runs_without_waiting (
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
INSERT INTO playbook_runs_without_waiting (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, error_code, started_at, ended_at)
SELECT id, playbook_id, playbook_rev, flow_sha256,
  CASE WHEN status = 'waiting_manual' THEN 'needs_review' ELSE status END,
  inputs_json, actor_kind,
  CASE WHEN status = 'waiting_manual' THEN 'interrupted' ELSE error_code END,
  started_at,
  CASE WHEN status = 'waiting_manual' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE ended_at END
FROM playbook_runs;
DROP TABLE playbook_runs;
ALTER TABLE playbook_runs_without_waiting RENAME TO playbook_runs;
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
INSERT INTO playbook_run_steps (run_id, seq, step_id, status, output_json_masked, error_code, started_at, ended_at)
SELECT run_id, seq, step_id,
  CASE WHEN status = 'waiting_manual' THEN 'needs_review' ELSE status END,
  output_json_masked,
  CASE WHEN status = 'waiting_manual' THEN 'interrupted' ELSE error_code END,
  started_at,
  CASE WHEN status = 'waiting_manual' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE ended_at END
FROM playbook_run_steps_kept;
DROP TABLE playbook_run_steps_kept;
