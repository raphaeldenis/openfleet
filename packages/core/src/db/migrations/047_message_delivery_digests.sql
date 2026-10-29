CREATE TABLE prompt_digests (
  cli_session_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (cli_session_id, digest)
) STRICT;

CREATE TABLE message_deliveries (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  submitted_at TEXT NOT NULL,
  confirmed_at TEXT,
  redelivered_at TEXT
) STRICT;

CREATE INDEX message_deliveries_digest ON message_deliveries (digest);
