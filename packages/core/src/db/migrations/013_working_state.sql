CREATE TABLE session_working_states (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  sections_json TEXT NOT NULL CHECK(json_valid(sections_json) AND json_type(sections_json) = 'object'),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_parent ON sessions(parent_id);
