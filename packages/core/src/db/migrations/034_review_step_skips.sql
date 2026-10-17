CREATE TABLE review_step_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('qe', 'qa', 'ponytail')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX review_step_skips_ticket ON review_step_skips(ticket, step);
