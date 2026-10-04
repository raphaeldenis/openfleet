CREATE TABLE scape_import_ledger (
  kind TEXT NOT NULL CHECK(kind <> ''),
  id TEXT NOT NULL CHECK(id <> ''),
  record_hash TEXT NOT NULL CHECK(length(record_hash) = 64),
  imported_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT;
