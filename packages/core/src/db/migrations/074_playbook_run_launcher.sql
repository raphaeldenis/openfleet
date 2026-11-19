-- A run records who launched it: a kind and, for a trigger, the id of the trigger. A trace for the reader, never a permission.
-- Both columns are nullable: a run created before this migration keeps NULL, which the daemon reads as an unknown launcher (no backfill).
-- The pair is written when the run is created and never changed afterwards; the guard below refuses any later update of either column.
ALTER TABLE playbook_runs ADD COLUMN launched_by_kind TEXT CHECK (launched_by_kind IN ('admin_api', 'trigger', 'unknown'));
ALTER TABLE playbook_runs ADD COLUMN launched_by_ref TEXT;

CREATE TRIGGER playbook_runs_launcher_fixed_at_creation
BEFORE UPDATE OF launched_by_kind, launched_by_ref ON playbook_runs BEGIN
  SELECT RAISE(ABORT, 'the launcher of a playbook run is fixed at creation');
END;
