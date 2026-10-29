CREATE TABLE review_finding_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  ticket TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('qe', 'qa', 'ponytail', 'adversarial')),
  severity TEXT NOT NULL CHECK (severity IN ('go', 'no-go', 'clean')),
  claim TEXT NOT NULL,
  sha TEXT NOT NULL,
  author_session_id TEXT NOT NULL,
  manager_session_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (report_id, position)
) STRICT;
CREATE INDEX review_finding_items_ticket ON review_finding_items(ticket, step, id);
