ALTER TABLE projects ADD COLUMN escalation_policy_json TEXT CHECK(escalation_policy_json IS NULL OR (json_valid(escalation_policy_json) AND json_type(escalation_policy_json) = 'object'));

CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  ticket TEXT NOT NULL CHECK(length(trim(ticket)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK((status = 'pending') = (resolved_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX escalations_one_pending_per_ticket ON escalations(manager_id, ticket) WHERE status = 'pending';

CREATE TABLE plan_question_batches (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES managers(session_id) ON DELETE CASCADE,
  ticket TEXT NOT NULL CHECK(length(trim(ticket)) > 0),
  plan_note_id TEXT NOT NULL,
  plan_note_rev INTEGER NOT NULL,
  arbiter_runs INTEGER NOT NULL DEFAULT 0 CHECK(arbiter_runs >= 0),
  criteria_opinion TEXT CHECK(criteria_opinion IN ('favourable', 'unfavourable', 'not_asked')),
  criteria_reasons_json TEXT CHECK(json_valid(criteria_reasons_json) AND json_type(criteria_reasons_json) = 'array'),
  created_at TEXT NOT NULL,
  CHECK((criteria_opinion IS NULL) = (criteria_reasons_json IS NULL))
) STRICT;
CREATE INDEX plan_question_batches_by_ticket ON plan_question_batches(manager_id, ticket, created_at);

CREATE TABLE plan_questions (
  batch_id TEXT NOT NULL REFERENCES plan_question_batches(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  text TEXT NOT NULL,
  declared_class TEXT NOT NULL,
  computed_classes_json TEXT NOT NULL CHECK(json_valid(computed_classes_json) AND json_type(computed_classes_json) = 'array'),
  effective_classes_json TEXT NOT NULL CHECK(json_valid(effective_classes_json) AND json_type(effective_classes_json) = 'array'),
  route TEXT NOT NULL CHECK(route IN ('human', 'self', 'arbiter')),
  status TEXT NOT NULL CHECK(status IN ('open', 'decided', 'self_resolved', 'pending_human', 'answered')),
  reason TEXT,
  options_json TEXT CHECK(options_json IS NULL OR (json_valid(options_json) AND json_type(options_json) = 'array')),
  recommendation TEXT,
  paths_json TEXT CHECK(paths_json IS NULL OR (json_valid(paths_json) AND json_type(paths_json) = 'array')),
  resolution_json TEXT CHECK(resolution_json IS NULL OR (json_valid(resolution_json) AND json_type(resolution_json) = 'object')),
  escalation_id TEXT REFERENCES escalations(id) ON DELETE SET NULL,
  human_answer TEXT,
  answered_at TEXT,
  PRIMARY KEY (batch_id, question_id)
) STRICT;
CREATE INDEX plan_questions_by_escalation ON plan_questions(escalation_id);

CREATE TABLE arbiter_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('decided', 'needs_human')),
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  raise_to TEXT CHECK(raise_to IN ('contract', 'security', 'deployment', 'history_rewrite', 'dod_waiver', 'spend', 'visual_qa')),
  evidence_json TEXT CHECK(evidence_json IS NULL OR (json_valid(evidence_json) AND json_type(evidence_json) = 'object')),
  arbiter_session_id TEXT NOT NULL,
  plan_note_rev INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id, question_id) REFERENCES plan_questions(batch_id, question_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX arbiter_decisions_by_question ON arbiter_decisions(batch_id, question_id, id);
