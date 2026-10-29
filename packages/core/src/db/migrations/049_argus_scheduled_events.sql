CREATE TABLE argus_scheduled_events (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  creator TEXT NOT NULL CHECK (creator IN ('manager', 'human')),
  title TEXT,
  message TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'cancelled')),
  created_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;
CREATE INDEX argus_scheduled_events_pending ON argus_scheduled_events(manager_id, status, due_at);
