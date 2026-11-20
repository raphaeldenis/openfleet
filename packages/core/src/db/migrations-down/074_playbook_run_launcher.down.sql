-- Drops the launcher guard and the two columns. Neither column is indexed, nor part of a key or a CHECK that spans other columns, so DROP COLUMN loses no run, no step and no index.
DROP TRIGGER playbook_runs_launcher_fixed_at_creation;
ALTER TABLE playbook_runs DROP COLUMN launched_by_kind;
ALTER TABLE playbook_runs DROP COLUMN launched_by_ref;
