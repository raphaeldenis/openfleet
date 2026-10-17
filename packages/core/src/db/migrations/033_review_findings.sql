CREATE TABLE review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('qe', 'qa', 'ponytail', 'adversarial')),
  severity TEXT NOT NULL CHECK (severity IN ('go', 'no-go', 'clean')),
  claim TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  sha TEXT NOT NULL,
  author_session_id TEXT NOT NULL,
  manager_session_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX review_findings_ticket ON review_findings(ticket, step, id);
CREATE INDEX review_findings_manager ON review_findings(manager_session_id, step, id);
