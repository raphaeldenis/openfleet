CREATE TABLE session_cli_ids (
  cli_session_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id)
) STRICT;

INSERT INTO session_cli_ids (cli_session_id, session_id)
  SELECT cli_session_id, id FROM sessions WHERE cli_session_id IS NOT NULL;
